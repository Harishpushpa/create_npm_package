const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

try {
  console.log('DEBUG INIT_CWD:', process.env.INIT_CWD);
  console.log('DEBUG process.cwd():', process.cwd());

  const cwd = process.env.INIT_CWD || process.cwd();
  const gitDir = path.join(cwd, '.git');

  console.log('DEBUG checking gitDir at:', gitDir);

  if (fs.existsSync(gitDir)) {
    console.log('🔧 Setting up license-gatekeeper pre-commit hook...');
    execSync('npx husky init', { stdio: 'inherit', cwd });

    const preCommitPath = path.join(cwd, '.husky', 'pre-commit');
fs.writeFileSync(preCommitPath, 'npx --no-install license-gatekeeper\n');

    console.log('✅ license-gatekeeper pre-commit hook installed!');
  } else {
    console.log('⚠️  No git repo found — skipping husky setup. Run "git init" first.');
  }
} catch (e) {
  console.log('⚠️  Could not auto-setup husky:', e.message);
}