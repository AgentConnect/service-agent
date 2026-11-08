"""Install only the independent anp-demo.awiki.info service and its own database."""

import argparse
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import subprocess
import time
import urllib.request

ROOT = Path('/var/lib/awiki-anp-demo')
SOCKET = '/run/awiki-anp-postgres'
ORIGIN = 'https://anp-demo.awiki.info'
PG = Path('/usr/lib/postgresql/14/bin')
TEMPLATES = Path(__file__).resolve().parent


def run(*argv, **kwargs):
    return subprocess.run(argv, check=True, text=True, **kwargs)


def as_pg(*argv, **kwargs):
    return run('runuser', '-u', 'awiki_anp_pg', '--', *argv, **kwargs)


def sql(query):
    return as_pg(str(PG / 'psql'), '-h', SOCKET, '-d', 'postgres', '-At',
                 '-v', 'ON_ERROR_STOP=1', '-c', query, capture_output=True).stdout.strip()


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run as root')
    parser = argparse.ArgumentParser()
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--commit', required=True)
    args = parser.parse_args()
    if len(args.commit) != 40 or any(c not in '0123456789abcdef' for c in args.commit):
        raise SystemExit('Expected a full source commit')
    candidate = args.candidate.resolve()
    if json.loads((candidate / 'package.json').read_text())['name'] != '@agentconnect/service-agent':
        raise SystemExit('Unexpected runtime package')
    run('groupadd', '-f', '--system', 'awiki_anp_access')
    for user in ['awiki_anp_pg', 'awiki_anp_demo']:
        try:
            pwd.getpwnam(user)
        except KeyError:
            run('useradd', '--system', '--no-create-home', '--gid', 'awiki_anp_access',
                '--shell', '/usr/sbin/nologin', user)
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / 'releases').mkdir(exist_ok=True)
    data = ROOT / 'postgres/data'
    if not data.exists():
        run('install', '-d', '-o', 'awiki_anp_pg', '-g', 'awiki_anp_access', '-m', '0700', str(data.parent))
        as_pg(str(PG / 'initdb'), '-D', str(data), '--auth-local=peer', '--auth-host=reject', '--no-locale', '-E', 'UTF8', stdout=subprocess.DEVNULL)
        with (data / 'postgresql.conf').open('a') as stream:
            stream.write("\nlisten_addresses = ''\nunix_socket_directories = '/run/awiki-anp-postgres'\nunix_socket_group = 'awiki_anp_access'\nunix_socket_permissions = 0770\n")
    for name in ['awiki-anp-postgres.service', 'awiki-anp-demo.service']:
        run('install', '-m', '0644', str(TEMPLATES / name), '/etc/systemd/system/' + name)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', '--now', 'awiki-anp-postgres.service')
    for attempt in range(30):
        try:
            sql('SELECT 1'); break
        except subprocess.CalledProcessError:
            if attempt == 29:
                raise
            time.sleep(0.2)
    if sql("SELECT 1 FROM pg_roles WHERE rolname='awiki_anp_demo'") != '1':
        sql('CREATE ROLE awiki_anp_demo LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE')
    if sql("SELECT 1 FROM pg_database WHERE datname='awiki_anp_demo'") != '1':
        as_pg(str(PG / 'createdb'), '-h', SOCKET, '-O', 'awiki_anp_demo', 'awiki_anp_demo')
    # Preserve and restore-check the exact owned database before schema/config setup.
    backup = ROOT / 'postgres' / ('pre-' + args.commit + '.dump')
    if not backup.exists():
        as_pg(str(PG / 'pg_dump'), '-h', SOCKET, '-Fc', '-f', str(backup), 'awiki_anp_demo')
        scratch = 'anp_restore_' + args.commit[:12]
        as_pg(str(PG / 'createdb'), '-h', SOCKET, scratch)
        try:
            as_pg(str(PG / 'pg_restore'), '-h', SOCKET, '-d', scratch, '--exit-on-error', str(backup), stdout=subprocess.DEVNULL)
        finally:
            as_pg(str(PG / 'dropdb'), '-h', SOCKET, scratch)
    release = ROOT / 'releases' / args.commit
    if not release.exists():
        shutil.copytree(candidate, release)
        run('chown', '-R', 'root:root', str(release))
    current = ROOT / 'current'
    old_release = current.resolve() if current.is_symlink() else None
    temporary = ROOT / 'current.next'
    if temporary.is_symlink(): temporary.unlink()
    temporary.symlink_to(release)
    temporary.replace(current)
    protected = Path('/etc/awiki-anp-demo')
    protected.mkdir(mode=0o700, exist_ok=True)
    env_file = protected / 'runtime.env'
    if not env_file.exists():
        config = dict(NODE_ENV='production', SERVICE_ORIGIN=ORIGIN, OAUTH_ISSUER=ORIGIN,
            MCP_RESOURCE=ORIGIN + '/mcp', OAUTH_SCOPES='protocol.read message.write',
            DATABASE_URL='postgresql:///awiki_anp_demo?host=' + SOCKET + '&user=awiki_anp_demo',
            RS_ID='anp-demo-mcp', RS_SECRET=secrets.token_urlsafe(48),
            PROTOCOL_CATALOG_FILE=str(current / 'protocol-catalog.json'),
            ADMISSION_POLICY='open_basic', ACCEPTED_CUSTODY_CONDITION='Local encrypted DID signing in the configured client',
            TOKEN_TTL_SECONDS='300', MAX_NEW_CLIENTS_HOUR='100', MAX_REQUESTS_CLIENT_MINUTE='30', MAX_REQUESTS_MINUTE='300',
            FETCH_GLOBAL_MINUTE='300', FETCH_ORIGIN_MINUTE='100', FETCH_CLIENT_MINUTE='60', FETCH_SOURCE_MINUTE='120',
            BIND_HOST='127.0.0.1', PORT='21696', ALLOW_LOOPBACK_PROXY='true')
        descriptor = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            for key, value in config.items(): stream.write(key + '=' + json.dumps(value) + '\n')
    config = {key: json.loads(value) for key, value in (line.split('=', 1) for line in env_file.read_text().splitlines() if line)}
    if config['SERVICE_ORIGIN'] != ORIGIN:
        raise SystemExit('Existing origin differs')
    process_env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', **config}
    run('runuser', '-u', 'awiki_anp_demo', '--', str(current / 'node'), str(current / 'ts/dist/scripts/migrate.js'), env=process_env)
    configured = ROOT / 'configured.json'
    if not configured.exists():
        run('runuser', '-u', 'awiki_anp_demo', '--', str(current / 'node'), str(current / 'ts/dist/scripts/configure.js'), env=process_env)
        configured.write_text(json.dumps({'origin': ORIGIN, 'database': 'awiki_anp_demo'}))
    (ROOT / 'public/test-identities').mkdir(parents=True, exist_ok=True)
    run('systemctl', 'enable', 'awiki-anp-demo.service')
    run('systemctl', 'restart', 'awiki-anp-demo.service')
    for attempt in range(40):
        try:
            with urllib.request.urlopen('http://127.0.0.1:21696/.well-known/agent-descriptions', timeout=2) as response:
                if response.status == 200: break
        except OSError:
            if attempt == 39: raise
            time.sleep(0.25)
    nginx = Path('/etc/nginx/conf.d/awiki-anp-demo.conf')
    old_nginx = nginx.read_bytes() if nginx.exists() else None
    run('install', '-m', '0644', str(TEMPLATES / 'nginx.conf'), str(nginx))
    try:
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
    except Exception:
        if old_nginx is None: nginx.unlink()
        else: nginx.write_bytes(old_nginx)
        if old_release:
            temporary.symlink_to(old_release); temporary.replace(current)
            run('systemctl', 'restart', 'awiki-anp-demo.service')
        else: run('systemctl', 'stop', 'awiki-anp-demo.service')
        raise
    (ROOT / 'deployment.json').write_text(json.dumps({'origin': ORIGIN, 'commit': args.commit, 'release': str(release), 'backup': str(backup), 'previousRelease': str(old_release) if old_release else None}, indent=2) + '\n')
    print('Deployed independent ANP Service Agent at ' + ORIGIN)


if __name__ == '__main__':
    main()
