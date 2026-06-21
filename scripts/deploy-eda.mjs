import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const edaAppRoot = path.join(repoRoot, 'eda-app');
const manifestPath = path.join(edaAppRoot, 'cable_map', 'manifest.yaml');
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function printHelp() {
  console.log(`Usage:
  pnpm deploy:eda:local [-- --tag v0.1.0 --no-build]
  pnpm deploy:eda:ghcr [-- --tag v0.1.0]
  pnpm deploy:eda -- --source local|ghcr

Defaults:
  --source local
  --tag v${packageJson.version}
  --image ghcr.io/eda-labs/cable-map-runtime
  --local-registry localhost:15055

Modes:
  local  Build the runtime image, push it to the EDA dev registry with the same
         tag, and deploy from a temporary manifest that points at that local tag.
  ghcr   Build and push the runtime image to GHCR, then deploy from a temporary
         manifest that points at the GHCR tag.
`);
}

function parseArgs(argv) {
  const options = {
    source: process.env.EDA_DEPLOY_SOURCE ?? 'local',
    tag: process.env.RUNTIME_TAG ?? `v${packageJson.version}`,
    image: process.env.RUNTIME_IMAGE ?? 'ghcr.io/eda-labs/cable-map-runtime',
    localRegistry: process.env.EDA_LOCAL_REGISTRY ?? 'localhost:15055',
    build: process.env.NO_BUILD !== '1',
    push: process.env.NO_PUSH !== '1',
    skipGenerate: true,
    verbose: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    }
    const [key, inlineValue] = arg.split('=', 2);
    const value = inlineValue ?? argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (key === '--source') {
      options.source = value;
      if (inlineValue === undefined) i += 1;
    } else if (key === '--tag') {
      options.tag = value;
      if (inlineValue === undefined) i += 1;
    } else if (key === '--image') {
      options.image = value;
      if (inlineValue === undefined) i += 1;
    } else if (key === '--local-registry') {
      options.localRegistry = value;
      if (inlineValue === undefined) i += 1;
    } else if (arg === '--no-build') {
      options.build = false;
    } else if (arg === '--no-push') {
      options.push = false;
    } else if (arg === '--generate') {
      options.skipGenerate = false;
    } else if (arg === '--no-verbose') {
      options.verbose = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['local', 'ghcr'].includes(options.source)) {
    throw new Error(`--source must be "local" or "ghcr", got "${options.source}"`);
  }

  return options;
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

let activePortForward;
let activeTmpDir;

function cleanup() {
  if (activeTmpDir) {
    rmSync(activeTmpDir, { recursive: true, force: true });
    activeTmpDir = undefined;
  }
  if (activePortForward) {
    activePortForward.kill('SIGINT');
    activePortForward = undefined;
  }
}

process.once('SIGINT', () => {
  cleanup();
  process.exit(130);
});

process.once('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

function imagePathWithoutRegistry(image) {
  const parts = image.split('/');
  const first = parts[0];
  if (first.includes('.') || first.includes(':') || first === 'localhost') {
    return parts.slice(1).join('/');
  }
  return image;
}

function withTag(image, tag) {
  return `${image}:${tag}`;
}

function replaceRuntimeImage(manifest, imageRef) {
  const dependencyImage = /(\n\s*dependencies:\s*\n\s*-\s*container:\s*\n\s*image:\s*)\S+(\s*\n\s*name:\s*cable-map\b)/;
  if (!dependencyImage.test(manifest)) {
    throw new Error(`Could not find cable-map runtime dependency in ${manifestPath}`);
  }
  return manifest.replace(dependencyImage, `$1${imageRef}$2`);
}

function createDeployManifest(imageRef) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'cable-map-eda-'));
  const tmpManifest = path.join(tmpDir, 'manifest.yaml');
  const manifest = readFileSync(manifestPath, 'utf8');
  writeFileSync(tmpManifest, replaceRuntimeImage(manifest, imageRef));
  return { tmpDir, tmpManifest };
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(250);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

async function waitForRegistry(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const poll = async () => {
    if (Date.now() >= deadline) {
      return false;
    }
    if (await canConnect(host, port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    return poll();
  };

  return poll();
}

async function ensureLocalRegistryForward(localRegistry) {
  const [host, portText] = localRegistry.split(':');
  const port = Number(portText);
  if (!host || !port) {
    throw new Error(`--local-registry must look like host:port, got "${localRegistry}"`);
  }

  if (!['localhost', '127.0.0.1'].includes(host)) {
    if (!(await waitForRegistry(host, port, 1000))) {
      throw new Error(`Registry ${localRegistry} is not reachable`);
    }
    return undefined;
  }

  if (await waitForRegistry(host, port, 1000)) {
    console.log(`[deploy-eda] using existing registry connection at ${localRegistry}`);
    return undefined;
  }

  console.log(`[deploy-eda] forwarding ${localRegistry} to eda-system/edabuilder-in-cluster-dev-registry`);
  const child = spawn(
    'kubectl',
    [
      '-n',
      'eda-system',
      'port-forward',
      'svc/edabuilder-in-cluster-dev-registry',
      `${port}:5555`,
    ],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  child.stdout.on('data', (data) => process.stdout.write(data));
  child.stderr.on('data', (data) => process.stderr.write(data));

  if (!(await waitForRegistry(host, port, 10_000))) {
    child.kill('SIGINT');
    throw new Error(`Timed out waiting for registry forward at ${localRegistry}`);
  }

  return child;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const runtimeRef = withTag(options.image, options.tag);
  const localRuntimeRef = withTag(
    `${options.localRegistry}/${imagePathWithoutRegistry(options.image)}`,
    options.tag,
  );
  const deployRuntimeRef = options.source === 'local' ? localRuntimeRef : runtimeRef;

  let portForward;
  let tmpManifest;

  try {
    if (options.build) {
      run('docker', ['build', '-t', runtimeRef, '.']);
    } else {
      run('docker', ['image', 'inspect', '--format', '{{.Id}}', runtimeRef]);
    }

    if (options.source === 'local') {
      portForward = await ensureLocalRegistryForward(options.localRegistry);
      activePortForward = portForward;
      run('docker', ['tag', runtimeRef, localRuntimeRef]);
      if (options.push) {
        run('docker', ['push', localRuntimeRef]);
      }
    } else if (options.push) {
      run('docker', ['push', runtimeRef]);
      run('docker', ['pull', runtimeRef]);
    }

    tmpManifest = createDeployManifest(deployRuntimeRef);
    activeTmpDir = tmpManifest.tmpDir;
    const edaArgs = [
      'deploy',
      '--app',
      `manifest=${tmpManifest.tmpManifest},context=${edaAppRoot}`,
    ];
    if (options.skipGenerate) {
      edaArgs.push('--skip-generate');
    }
    if (options.verbose) {
      edaArgs.push('--verbose');
    }

    run('edabuilder', edaArgs, { cwd: edaAppRoot });
    console.log(`[deploy-eda] deployed with runtime dependency ${deployRuntimeRef}`);
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(`[deploy-eda] ${error.message}`);
  process.exit(1);
});
