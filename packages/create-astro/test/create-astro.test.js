import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { suite } from 'uvu';
import execa from 'execa';
import glob from 'tiny-glob';
import * as assert from 'uvu/assert';
import { TEMPLATES } from '../dist/templates.js';

// config
const GITHUB_SHA = process.env.GITHUB_SHA || execa.sync('git', ['rev-parse', 'HEAD']).stdout; // process.env.GITHUB_SHA will be set in CI; if testing locally execa() will gather this
const TEMPLATE_SETUP = {}; // keep track of every template’s setup state
const FIXTURES_DIR = path.join(fileURLToPath(path.dirname(import.meta.url)), 'fixtures');

// helpers
async function fetch(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        // not OK
        if (res.statusCode !== 200) {
          reject(res.statusCode);
          return;
        }

        // OK
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      })
      .on('error', (err) => {
        // other error
        reject(err);
      });
  });
}

async function setup(template) {
  await TEMPLATE_SETUP[template];
}

// test
const CreateAstro = suite('npm init astro');

for (let n = 0; n < TEMPLATES.length; n++) {
  // setup (done here rather than .before() because uvu swallows errors there)
  const template = TEMPLATES[n].value;
  const templateDir = path.join(FIXTURES_DIR, template);
  TEMPLATE_SETUP[template] = execa('../../create-astro.mjs', [template, '--template', template, '--commit', GITHUB_SHA, '--force-overwrite'], {
    cwd: FIXTURES_DIR,
  }).then(() => execa('npm', ['install', '--no-package-lock', '--silent'], { cwd: templateDir }));

  CreateAstro(`${template} (install)`, async () => {
    await setup(template);

    const DOES_HAVE = ['.gitignore', 'package.json', 'public', 'src'];
    const DOES_NOT_HAVE = ['.git', 'meta.json'];

    // test: template contains essential files & folders
    for (const file of DOES_HAVE) {
      assert.ok(fs.existsSync(path.join(templateDir, file)), `missing ${file}`);
    }

    // test: template DOES NOT contain files supposed to be stripped away
    for (const file of DOES_NOT_HAVE) {
      assert.not.ok(fs.existsSync(path.join(templateDir, file)), `failed to clean up ${file}`);
    }
  });

  CreateAstro(`${template} (dev)`, async () => {
    await setup(template);

    // start dev server, and wait until the "Server started in" message appears
    const port = 3000 + n; // start new port per test
    const devServer = execa('npm', ['run', 'start', '--', '--port', port], { cwd: templateDir });
    let sigkill = setTimeout(() => {
      throw new Error(`Dev server failed to start`); // if 10s has gone by with no update, kill process
    }, 10000);
    await new Promise((resolve, reject) => {
      devServer.stdout.on('data', (data) => {
        clearTimeout(sigkill);
        sigkill = setTimeout(() => {
          reject(`Dev server failed to start`);
        }, 10000);
        if (data.toString('utf8').includes('Server started')) resolve();
      });
      devServer.stderr.on('data', (data) => {
        reject(data.toString('utf8'));
      });
    });
    clearTimeout(sigkill);

    // ping dev server
    const { statusCode, body } = (await fetch(`http://localhost:${port}`)) || {};

    // expect 200 to be returned with some response
    assert.equal(statusCode, 200, 'didn’t respond with 200');
    assert.ok(body, 'returned empty response');

    // clean up
    devServer.kill();
  });

  CreateAstro(`${template} (build)`, async () => {
    await setup(template);

    const MUST_HAVE_FILES = ['index.html', '_astro'];

    // build template
    await execa('npm', ['run', 'build'], { cwd: templateDir });

    // scan build dir
    const builtFiles = await glob('**/*', { cwd: path.join(templateDir, 'dist') });
    for (const file of MUST_HAVE_FILES) {
      assert.ok(builtFiles.includes(file), `didn’t build ${file}`);
    }
  });
}

// run tests
CreateAstro.run();
