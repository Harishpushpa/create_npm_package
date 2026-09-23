require('dotenv').config({ path: process.cwd() + '/.env' });
const checker = require('license-checker');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(process.cwd(), '.license-cache.json');
const OVERRIDES_FILE = path.join(process.cwd(), 'license-overrides.json');

// ---------- SPDX permissive license list ----------
const PERMISSIVE_LICENSES = [
  'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0',
  'CC0-1.0', 'Unlicense', '0BSD', 'BlueOak-1.0.0', 'CC-BY-3.0'
];

const RESTRICTIVE_KEYWORDS = ['GPL', 'AGPL', 'NC', 'NonCommercial', 'CC-BY-NC'];

// ---------- Load cache ----------
function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.log('⚠️ Could not save cache:', e.message);
  }
}

// ---------- Load overrides ----------
function loadOverrides() {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

// ---------- SPDX quick check ----------
function checkSPDX(license) {
  if (!license || license === 'UNKNOWN') return null;

  if (license.includes(' OR ')) {
    const options = license.replace(/[()]/g, '').split(' OR ').map(s => s.trim());
    const permissiveChoice = options.find(opt => PERMISSIVE_LICENSES.includes(opt));
    if (permissiveChoice) {
      return {
        allowed: true,
        reason: `${license} — chose ${permissiveChoice} (permissive) of "${options.join(' OR ')}": SPDX-verified permissive, commercial use OK`,
        source: 'SPDX'
      };
    }
    return null;
  }

  if (license.includes(' AND ')) {
    const parts = license.replace(/[()]/g, '').split(' AND ').map(s => s.trim());
    const allPermissive = parts.every(p => PERMISSIVE_LICENSES.includes(p));
    if (allPermissive) {
      return {
        allowed: true,
        reason: `${license} — ${parts.join(' (permissive) AND ')} (permissive): SPDX-verified permissive, commercial use OK`,
        source: 'SPDX'
      };
    }
    return null;
  }

  if (PERMISSIVE_LICENSES.includes(license)) {
    return {
      allowed: true,
      reason: `${license} — ${license} (permissive): SPDX-verified permissive, commercial use OK`,
      source: 'SPDX'
    };
  }

  const isRestrictive = RESTRICTIVE_KEYWORDS.some(kw => license.includes(kw));
  if (isRestrictive) {
    return {
      allowed: false,
      reason: `License ${license} is restrictive/copyleft or prohibits commercial use, needs legal review.`,
      source: 'SPDX'
    };
  }

  return null;
}

// ---------- Web search via npm registry ----------
async function webSearchLicense(pkgName, version) {
  try {
    const npmRes = await axios.get(`https://registry.npmjs.org/${pkgName}`, { timeout: 5000 });
    const versionData =
      npmRes.data.versions?.[version] ||
      npmRes.data.versions?.[Object.keys(npmRes.data.versions || {}).pop()];

    const npmLicense = versionData?.license || npmRes.data.license || 'UNKNOWN';
    const repoUrl =
      (versionData?.repository && versionData.repository.url) ||
      (npmRes.data.repository && npmRes.data.repository.url) ||
      'N/A';
    const description = versionData?.description || npmRes.data.description || '';

    return { found: true, npmLicense, repoUrl, description };
  } catch (e) {
    return { found: false };
  }
}

// ---------- AI check (with optional web context) ----------
async function checkWithAI(pkgName, license, repo, version) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return { allowed: false, reason: 'Missing OPENAI_API_KEY', source: 'AI' };
  }

  let webInfo = null;
  const needsWebSearch =
    !license ||
    license === 'UNKNOWN' ||
    license.includes('SEE LICENSE') ||
    license.includes('(');

  if (needsWebSearch) {
    console.log(`🔎 Checking additional info for ${pkgName}...`);
    webInfo = await webSearchLicense(pkgName, version);
  }

  const contextForAI = webInfo?.found
    ? `Package: ${pkgName}, Declared License: ${license}, NPM Registry License: ${webInfo.npmLicense}, Repository: ${webInfo.repoUrl}, Description: ${webInfo.description}`
    : `Package: ${pkgName}, License: ${license}, Repo: ${repo || 'N/A'}`;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You check if an npm package license permits commercial use, using SPDX data and any additional web/registry context provided. Reply ONLY in JSON: {"allowed": true/false, "reason": "short reason"}'
          },
          { role: 'user', content: contextForAI }
        ]
      },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 15000 }
    );

    const text = response.data.choices[0].message.content;
    const result = JSON.parse(text);

    return {
      ...result,
      source: webInfo?.found ? 'AI+Web' : 'AI'
    };
  } catch (e) {
    return {
      allowed: false,
      reason: 'AI check failed — blocking by default for safety',
      source: 'AI'
    };
  }
}

// ---------- Main scan ----------
checker.init({ start: '.' }, async (err, packages) => {
  if (err) {
    console.error('❌ License scan failed:', err);
    process.exit(1);
  }

  console.log('\n🔍 Checking package licenses for commercial use...\n');

  const cache = loadCache();
  const overrides = loadOverrides();
  const results = [];
  let blocked = false;

  for (const [pkgKey, info] of Object.entries(packages)) {
    const license = info.licenses || 'UNKNOWN';
    const [pkgName, version] = pkgKey.split(/@(?=[^@]+$)/);

    if (overrides[pkgKey]) {
      results.push({
        pkgName: pkgKey,
        license,
        allowed: overrides[pkgKey].allowed,
        reason: `Override: ${overrides[pkgKey].reason}`,
        source: 'OVERRIDE'
      });
      if (!overrides[pkgKey].allowed) blocked = true;
      continue;
    }

    const cacheKey = `${pkgKey}:${license}`;
    if (cache[cacheKey]) {
      const cached = cache[cacheKey];
      results.push({ pkgName: pkgKey, license, ...cached, source: `${cached.source}:cache` });
      if (!cached.allowed) blocked = true;
      continue;
    }

    const spdxResult = checkSPDX(license);
    if (spdxResult) {
      results.push({ pkgName: pkgKey, license, ...spdxResult });
      cache[cacheKey] = spdxResult;
      if (!spdxResult.allowed) blocked = true;
      continue;
    }

    const aiResult = await checkWithAI(pkgName, license, info.repository, version);
    results.push({ pkgName: pkgKey, license, ...aiResult });
    cache[cacheKey] = aiResult;
    if (!aiResult.allowed) blocked = true;
  }

  saveCache(cache);

  // ---------- Ultra-simple human output ----------
  const allowedResults = results.filter(r => r.allowed);
  const blockedResults = results.filter(r => !r.allowed);

  console.log('');
  console.log('┌─────────────────────────────────────────┐');
  console.log('│         LICENSE CHECK RESULT             │');
  console.log('└─────────────────────────────────────────┘');
  console.log('');
  console.log(`  Total packages checked   : ${results.length}`);
  console.log(`  Safe for commercial use  : ${allowedResults.length} ✅`);
  console.log(`  Needs review             : ${blockedResults.length} ${blockedResults.length > 0 ? '❌' : '✅'}`);
  console.log('');

  if (blockedResults.length > 0) {
    console.log('⚠️  The following packages need your attention:');
    console.log('');
    blockedResults
      .sort((a, b) => a.pkgName.localeCompare(b.pkgName))
      .forEach(r => {
        console.log(`   • ${r.pkgName}  →  ${r.license}`);
      });
    console.log('');
    console.log('👉 Why blocked? These licenses either restrict commercial use');
    console.log('   or could not be automatically verified as safe.');
    console.log('');
    console.log('✅ To approve after checking with your legal/team lead, add to license-overrides.json:');
    console.log('   { "package-name@version": { "allowed": true, "reason": "approved by <name>" } }');
    console.log('');
    console.log('🚫 COMMIT BLOCKED');
    process.exit(1);
  } else {
    console.log('🎉 All packages are safe for commercial use.');
    console.log('✅ COMMIT ALLOWED');
    process.exit(0);
  }
});