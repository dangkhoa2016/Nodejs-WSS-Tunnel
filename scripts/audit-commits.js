import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAX_SUBJECT_LENGTH = 72;
const MAX_CHURN = 1000;

const SUBJECT_PATTERN =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9-]+\))?!?: .+$/;

const TRAILER_PATTERN = /^[A-Za-z0-9-]+: .+$/;

export function validateSubject(subject) {
  const diagnostics = [];

  if (subject.length > MAX_SUBJECT_LENGTH) {
    diagnostics.push(`Subject is too long (${subject.length} characters; max ${MAX_SUBJECT_LENGTH})`);
  }

  if (!SUBJECT_PATTERN.test(subject)) {
    diagnostics.push('Subject is not a valid Conventional Commit');
  }

  return diagnostics;
}

export function validateBody(body) {
  const diagnostics = [];

  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('- ') || TRAILER_PATTERN.test(line)) continue;
    diagnostics.push(`Body line is not a bullet or trailer: ${line.trim()}`);
  }

  return diagnostics;
}

export function parseNumstat(text) {
  let churn = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const [added, deleted] = parts;
    if (added === '-' || deleted === '-') continue;

    const additions = Number.parseInt(added, 10);
    const deletions = Number.parseInt(deleted, 10);
    if (Number.isNaN(additions) || Number.isNaN(deletions)) continue;

    churn += additions + deletions;
  }

  return churn;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

export function auditCommit(sha) {
  const subject = git(['show', '-s', '--format=%s', sha]).replace(/\n$/, '');
  const body = git(['show', '-s', '--format=%b', sha]);
  const numstat = git(['show', '--numstat', '--format=', sha]);

  const diagnostics = [...validateSubject(subject), ...validateBody(body)];

  const churn = parseNumstat(numstat);
  if (churn >= MAX_CHURN) {
    diagnostics.push(`Churn of ${churn} lines meets or exceeds the ${MAX_CHURN}-line threshold`);
  }

  return { sha, diagnostics };
}

export function auditRange(base, head) {
  const shas = git(['rev-list', `${base}..${head}`])
    .split('\n')
    .filter(Boolean);

  if (shas.length === 0) {
    return { total: 0, violations: [] };
  }

  const violations = [];

  for (const sha of shas) {
    for (const diagnostic of auditCommit(sha).diagnostics) {
      violations.push(`${sha} ${diagnostic}`);
    }
  }

  return { total: shas.length, violations };
}

function main() {
  const args = process.argv.slice(2);
  const singleIndex = args.indexOf('--single');

  if (singleIndex !== -1) {
    const sha = args[singleIndex + 1];
    if (!sha) {
      console.error('Usage: node scripts/audit-commits.js --single <revision>');
      return 2;
    }

    const { diagnostics } = auditCommit(sha);

    if (diagnostics.length === 0) {
      console.log(`${sha} passes the history policy.`);
      return 0;
    }

    console.error(`Found ${diagnostics.length} violation(s):`);
    for (const diagnostic of diagnostics) {
      console.error(`- ${sha} ${diagnostic}`);
    }
    return 1;
  }

  const baseIndex = args.indexOf('--base');
  const headIndex = args.indexOf('--head');

  if (baseIndex === -1 || headIndex === -1 || !args[baseIndex + 1] || !args[headIndex + 1]) {
    console.error('Usage: node scripts/audit-commits.js --base <revision> --head <revision>');
    return 2;
  }

  const base = args[baseIndex + 1];
  const head = args[headIndex + 1];

  const { total, violations } = auditRange(base, head);

  if (total === 0) {
    console.log(`No commits in range ${base}..${head}. Nothing to audit.`);
    return 0;
  }

  console.log(`Auditing ${total} commit(s) in range ${base}..${head}.`);

  if (violations.length === 0) {
    console.log('All commits pass the history policy.');
    return 0;
  }

  console.error(`Found ${violations.length} violation(s):`);
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
