"""Configure the public Supabase connection; rejects privileged keys."""
import argparse
import base64
import getpass
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def validate(url, key):
    parsed = urllib.parse.urlsplit(url.strip())
    if parsed.scheme != 'https' or not re.fullmatch(r'[a-z0-9-]+\.supabase\.co', parsed.netloc) or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
        raise ValueError('请使用项目的 https://项目编号.supabase.co 地址')
    key = key.strip()
    if key.startswith('sb_publishable_'):
        if not re.fullmatch(r'sb_publishable_[A-Za-z0-9_-]{16,300}', key):
            raise ValueError('公开publishable key格式不完整')
    else:
        try:
            parts = key.split('.')
            if len(parts) != 3 or not all(re.fullmatch('[A-Za-z0-9_-]+', p) for p in parts):
                raise ValueError()
            payload = json.loads(base64.urlsafe_b64decode(parts[1] + '=' * (-len(parts[1]) % 4)))
            if payload.get('role') != 'anon':
                raise ValueError()
            if payload.get('ref') and payload['ref'] != parsed.hostname.split('.')[0]:
                raise ValueError()
        except (ValueError, TypeError, KeyError, UnicodeError):
            raise ValueError('只接受公开publishable key或anon key。管理员secret/service_role key禁止放入网页。') from None
    return {'provider': 'supabase', 'url': urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, '', '', '')), 'publishableKey': key}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('服务发生重定向，已停止发送项目配置')


def check_connection(config):
    request = urllib.request.Request(config['url'] + '/auth/v1/settings', headers={'apikey': config['publishableKey'], 'Accept': 'application/json'})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
            settings = json.load(response)
    except (urllib.error.URLError, ValueError, TimeoutError):
        raise ValueError('未能连接项目认证服务；请核对项目地址、公开Key和项目运行状态。没有写入配置。') from None
    if not isinstance(settings, dict):
        raise ValueError('认证服务响应格式异常，没有写入配置')
    return settings


def main():
    parser = argparse.ArgumentParser(description='启用免费云存档项目连接')
    parser.add_argument('--check', action='store_true', help='仅检查已有连接，不修改配置')
    args = parser.parse_args()
    path = ROOT / 'overrides/cloud-config.js'
    if args.check:
        text = path.read_text(encoding='utf-8-sig')
        raw = json.JSONDecoder().raw_decode(text[text.index('{'):])[0]
        config = validate(raw['url'], raw['publishableKey'])
    else:
        print('准备好你的Supabase项目URL和公开publishable/anon key。不要使用secret/service_role key。')
        url = input('项目URL：').strip()
        key = getpass.getpass('公开Key（不回显）：').strip()
        config = validate(url, key)
    settings = check_connection(config)
    if not args.check:
        content = '// Public project settings only; never a service_role/secret key.\nwindow.CQUEST_CLOUD_CONFIG = ' + json.dumps(config, ensure_ascii=False, indent=2) + ';\n'
        # Same-volume replace; interrupted configuration cannot leave partial JS.
        temporary = path.with_suffix('.js.tmp')
        temporary.write_text(content, encoding='utf-8')
        temporary.replace(path)
    print('认证服务连接正常。请确认已执行 cloud/supabase.sql，再预览并发布。')
    print('这一步尚未验证真实注册和双设备同步；需发布后用自己的账号完成测试。')
    if settings.get('disable_signup'):
        print('项目当前禁止新用户注册，请在项目控制台核对注册设置。')
    return 0


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    try:
        raise SystemExit(main())
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
