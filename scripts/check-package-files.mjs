// CI guard: ensure the published npm tarball includes the build output (dist/).
//
// Why this exists: 1.6.1 was published WITHOUT dist/. package.json points main
// at dist/index.js but there was no "files" field and no .npmignore, so npm fell
// back to .gitignore (which lists dist/) and dropped the compiled output from the
// tarball — every consumer got "Module not found: @uoa-css-lab/duckscatter".
// This check makes that failure mode fail CI instead of shipping silently.
//
// Run after `npm run build` (so dist/ exists on disk).
import { execSync } from 'node:child_process';

const out = JSON.parse(execSync('npm pack --dry-run --json').toString());
const files = out[0].files.map((f) => f.path);
const required = ['dist/index.js', 'dist/index.d.ts'];
const missing = required.filter((r) => !files.includes(r));

if (missing.length > 0) {
  console.error(
    `::error::npm package is missing build output: ${missing.join(', ')}. ` +
      `Check the package.json "files" field / .npmignore (1.6.1 shipped without dist/).`
  );
  process.exit(1);
}

console.log(`OK: package tarball includes dist/ (${files.length} files total).`);
