import base64
import json
import unittest
from configure_cloud import validate


def token(payload):
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=')
    return 'header.' + body + '.signature'


class CloudConfigTests(unittest.TestCase):
    def test_public_publishable_key(self):
        result = validate('https://mytestproject.supabase.co/', 'sb_publishable_' + 'x' * 24)
        self.assertEqual(result['url'], 'https://mytestproject.supabase.co')

    def test_anon_key(self):
        result = validate('https://mytestproject.supabase.co', token({'role': 'anon', 'ref': 'mytestproject'}))
        self.assertEqual(result['provider'], 'supabase')

    def test_admin_key_is_rejected(self):
        for key in ['sb_secret_' + 'x' * 24, token({'role': 'service_role'}), token({'role': 'postgres'})]:
            with self.subTest(key_type=key.split('_')[0]):
                with self.assertRaises(ValueError):
                    validate('https://mytestproject.supabase.co', key)

    def test_unexpected_destination_is_rejected(self):
        for url in ['http://mytestproject.supabase.co', 'https://mytestproject.supabase.co.attacker.com', 'https://mytestproject.supabase.co@attacker.com', 'https://mytestproject.supabase.co?key=x', 'https://mytestproject.supabase.co/auth/v1']:
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    validate(url, 'sb_publishable_' + 'x' * 24)

    def test_legacy_key_for_other_project_is_rejected(self):
        with self.assertRaises(ValueError):
            validate('https://mytestproject.supabase.co', token({'role': 'anon', 'ref': 'otherproject'}))


if __name__ == '__main__':
    unittest.main()
