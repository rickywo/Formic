#!/usr/bin/env python3
"""
Security tests for Formic.

Unlike the other API suites, this suite does NOT use the already-running dev
server: it spawns its own short-lived server instances (via tsx) with the
specific environment each scenario needs:

1. Non-loopback bind (HOST=0.0.0.0) with FORMIC_AUTH_TOKEN:
   - requests without a Bearer token get 401
   - requests with the correct Bearer token get 200
2. Non-loopback bind WITHOUT FORMIC_AUTH_TOKEN: server refuses to start.
3. Telegram webhook with TELEGRAM_WEBHOOK_SECRET configured:
   - POST without X-Telegram-Bot-Api-Secret-Token gets 401
   - POST with a wrong secret gets 401
   - POST with the correct secret gets 200
   - LINE webhook behavior unchanged (401 without signature)
"""

import os
import shutil
import subprocess
import sys
import tempfile
import time

import requests

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)

AUTH_PORT = 8410
WEBHOOK_PORT = 8411
AUTH_TOKEN = 'test-security-suite-token'
WEBHOOK_SECRET = 'test-telegram-webhook-secret'
STARTUP_TIMEOUT = 60


def start_server(port, extra_env, workspace):
    """Spawn a Formic server via tsx with the given env; return the process."""
    env = os.environ.copy()
    # Isolate from the developer's .env / dev server configuration
    for var in ('FORMIC_AUTH_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET',
                'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'HOST'):
        env.pop(var, None)
    env['PORT'] = str(port)
    env['WORKSPACE_PATH'] = workspace
    env['FORMIC_QUEUE_ENABLED'] = 'false'
    env.update(extra_env)

    return subprocess.Popen(
        ['npx', 'tsx', 'src/server/index.ts'],
        cwd=REPO_ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def wait_for_server(port, proc):
    """Poll until the server answers (any HTTP status counts as 'up')."""
    deadline = time.time() + STARTUP_TIMEOUT
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        try:
            requests.get(f'http://127.0.0.1:{port}/api/board', timeout=2)
            return True
        except requests.exceptions.RequestException:
            time.sleep(0.5)
    return False


def stop_server(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def test_auth_token_enforcement():
    """Non-loopback bind: 401 without Bearer token, 200 with it."""
    print('\n--- Auth token enforcement (HOST=0.0.0.0 + FORMIC_AUTH_TOKEN) ---')
    workspace = tempfile.mkdtemp(prefix='formic-sec-auth-')
    proc = start_server(AUTH_PORT, {
        'HOST': '0.0.0.0',
        'FORMIC_AUTH_TOKEN': AUTH_TOKEN,
    }, workspace)
    try:
        if not wait_for_server(AUTH_PORT, proc):
            print('❌ Server with auth token failed to start')
            return False

        base = f'http://127.0.0.1:{AUTH_PORT}'

        r = requests.get(f'{base}/api/board', timeout=5)
        if r.status_code != 401:
            print(f'❌ Expected 401 without Authorization header, got {r.status_code}')
            return False
        print('✅ 401 without Authorization header')

        r = requests.get(f'{base}/api/board',
                         headers={'Authorization': 'Bearer wrong-token'}, timeout=5)
        if r.status_code != 401:
            print(f'❌ Expected 401 with wrong token, got {r.status_code}')
            return False
        print('✅ 401 with wrong Bearer token')

        r = requests.get(f'{base}/api/board',
                         headers={'Authorization': f'Bearer {AUTH_TOKEN}'}, timeout=5)
        if r.status_code != 200:
            print(f'❌ Expected 200 with valid token, got {r.status_code}')
            return False
        print('✅ 200 with valid Bearer token')
        return True
    finally:
        stop_server(proc)
        shutil.rmtree(workspace, ignore_errors=True)


def test_non_loopback_refused_without_token():
    """HOST=0.0.0.0 without FORMIC_AUTH_TOKEN must refuse to start."""
    print('\n--- Non-loopback bind refused without FORMIC_AUTH_TOKEN ---')
    workspace = tempfile.mkdtemp(prefix='formic-sec-guard-')
    proc = start_server(AUTH_PORT, {'HOST': '0.0.0.0'}, workspace)
    try:
        deadline = time.time() + STARTUP_TIMEOUT
        while time.time() < deadline and proc.poll() is None:
            time.sleep(0.5)
        if proc.poll() is None:
            print('❌ Server started on 0.0.0.0 without FORMIC_AUTH_TOKEN (guard missing)')
            return False
        if proc.returncode == 0:
            print(f'❌ Server exited 0, expected non-zero refusal (got {proc.returncode})')
            return False
        print(f'✅ Server refused to start (exit code {proc.returncode})')
        return True
    finally:
        stop_server(proc)
        shutil.rmtree(workspace, ignore_errors=True)


def test_telegram_webhook_secret():
    """Telegram webhook requires the correct X-Telegram-Bot-Api-Secret-Token."""
    print('\n--- Telegram webhook secret-token validation ---')
    workspace = tempfile.mkdtemp(prefix='formic-sec-webhook-')
    proc = start_server(WEBHOOK_PORT, {
        'TELEGRAM_BOT_TOKEN': 'dummy-bot-token-for-tests',
        'TELEGRAM_WEBHOOK_SECRET': WEBHOOK_SECRET,
    }, workspace)
    try:
        if not wait_for_server(WEBHOOK_PORT, proc):
            print('❌ Webhook test server failed to start')
            return False

        base = f'http://127.0.0.1:{WEBHOOK_PORT}'
        # Minimal well-formed update with no message content, so the handler
        # never attempts an outbound Telegram API call with the dummy token.
        update = {'update_id': 1}

        r = requests.post(f'{base}/api/webhooks/telegram', json=update, timeout=5)
        if r.status_code != 401:
            print(f'❌ Expected 401 without secret header, got {r.status_code}')
            return False
        print('✅ 401 without X-Telegram-Bot-Api-Secret-Token')

        r = requests.post(f'{base}/api/webhooks/telegram', json=update,
                          headers={'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret'},
                          timeout=5)
        if r.status_code != 401:
            print(f'❌ Expected 401 with wrong secret, got {r.status_code}')
            return False
        print('✅ 401 with wrong secret token')

        r = requests.post(f'{base}/api/webhooks/telegram', json=update,
                          headers={'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET},
                          timeout=5)
        if r.status_code != 200:
            print(f'❌ Expected 200 with correct secret, got {r.status_code}')
            return False
        print('✅ 200 with correct secret token')

        # LINE behavior unchanged: not configured here → 503; and when it is
        # configured it still requires a signature (covered implicitly by the
        # unchanged code path — assert the 503 to catch route regressions).
        r = requests.post(f'{base}/api/webhooks/line', json={'events': []}, timeout=5)
        if r.status_code != 503:
            print(f'❌ Expected 503 for unconfigured LINE webhook, got {r.status_code}')
            return False
        print('✅ LINE webhook route unchanged (503 when unconfigured)')
        return True
    finally:
        stop_server(proc)
        shutil.rmtree(workspace, ignore_errors=True)


def main():
    print('=' * 60)
    print('Formic Security Tests (auth token + webhook secrets)')
    print('=' * 60)

    results = [
        ('Auth token enforcement', test_auth_token_enforcement()),
        ('Non-loopback guard', test_non_loopback_refused_without_token()),
        ('Telegram webhook secret', test_telegram_webhook_secret()),
    ]

    print('\n' + '=' * 60)
    failed = [name for name, ok in results if not ok]
    for name, ok in results:
        print(f"  {'✅' if ok else '❌'} {name}")
    if failed:
        print(f'\n{len(failed)} security test group(s) failed')
        sys.exit(1)
    print('\nAll security tests passed')
    sys.exit(0)


if __name__ == '__main__':
    main()
