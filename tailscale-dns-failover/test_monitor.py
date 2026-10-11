import copy
import struct
import unittest
from unittest.mock import patch

import monitor


class FakeAPI:
    def __init__(self, enabled=True):
        self.value = {
            'nameservers': [{'address': 'https://dns.controld.com/profile', 'useWithExitNode': True}],
            'splitDNS': {'lan': [{'address': '192.0.2.53'}]},
            'searchPaths': ['lan'],
            'preferences': {'overrideLocalDNS': enabled, 'magicDNS': True},
        }
        self.writes = []

    def get(self):
        return copy.deepcopy(self.value)

    def put(self, value):
        self.writes.append(copy.deepcopy(value))
        self.value = copy.deepcopy(value)


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.config = {'expected_resolver_id': 'profile', 'auto_restore': False}
        self.state = {}
        self.api = FakeAPI()

    def tick(self, now, primary=False, backup=True):
        monitor.tick(self.config, self.state, primary, backup, now, self.api, lambda _: None)

    def fail(self):
        for now in (0, 20, 40):
            self.tick(now)

    def test_sustained_failure_preserves_all_other_dns_settings(self):
        before = self.api.get()
        self.tick(0)
        self.tick(20)
        self.assertEqual(self.api.writes, [])
        self.tick(40)
        self.assertIs(self.api.value['preferences']['overrideLocalDNS'], False)
        self.assertEqual(monitor.without_override(before), monitor.without_override(self.api.value))
        self.tick(100)
        self.assertEqual(len(self.api.writes), 1)

    def test_intermittent_failure_does_not_trigger(self):
        for now, healthy in ((0, False), (20, False), (40, True), (60, False), (80, False)):
            self.tick(now, primary=healthy)
        self.assertEqual(self.api.writes, [])

    def test_no_working_backup_no_toggle(self):
        for now in (0, 20, 40, 60):
            self.tick(now, backup=False)
        self.assertEqual(self.api.writes, [])

    def test_default_does_not_restore(self):
        self.fail()
        for now in range(60, 500, 20):
            self.tick(now, primary=True)
        self.assertEqual(len(self.api.writes), 1)

    def test_opt_in_restore_requires_five_minutes(self):
        self.config['auto_restore'] = True
        self.fail()
        for now in range(60, 360, 20):
            self.tick(now, primary=True)
        self.assertEqual(len(self.api.writes), 1)
        self.tick(360, primary=True)
        self.assertEqual(len(self.api.writes), 2)
        self.assertIs(self.api.value['preferences']['overrideLocalDNS'], True)

    def test_manual_off_never_auto_enabled(self):
        self.config['auto_restore'] = True
        self.api = FakeAPI(enabled=False)
        self.fail()
        for now in range(60, 500, 20):
            self.tick(now, primary=True)
        self.assertEqual(self.api.writes, [])

    def test_long_pause_resets_failure_streak(self):
        self.tick(0)
        self.tick(20)
        self.tick(200)
        self.assertEqual(self.api.writes, [])

    def test_api_failure_is_retried_with_backoff(self):
        self.tick(0)
        self.tick(20)
        with patch.object(self.api, 'get', side_effect=RuntimeError('unavailable')):
            with self.assertRaises(RuntimeError):
                self.tick(40)
        self.tick(60)
        self.assertEqual(self.api.writes, [])
        self.tick(100)
        self.assertEqual(len(self.api.writes), 1)

    def test_unrelated_profile_is_not_changed(self):
        self.config['expected_resolver_id'] = 'another-profile'
        self.tick(0)
        self.tick(20)
        with self.assertRaisesRegex(RuntimeError, 'no longer matches'):
            self.tick(40)
        self.assertEqual(self.api.writes, [])

    def test_intervening_admin_edit_is_not_overwritten(self):
        current = self.api.get()
        self.api.value['searchPaths'] = ['example.net']
        with self.assertRaisesRegex(RuntimeError, 'changed during check'):
            monitor.update(self.api, current, False)
        self.assertEqual(self.api.writes, [])

    def test_changed_configuration_cancels_recovery(self):
        self.config['auto_restore'] = True
        self.fail()
        self.api.value['searchPaths'] = ['example.net']
        for now in range(60, 380, 20):
            self.tick(now, primary=True)
        self.assertEqual(len(self.api.writes), 1)
        self.assertNotIn('restore_config', self.state)

    def test_post_explicitly_serializes_false(self):
        client = monitor.Client({})
        client.token = 'test-token'
        value = self.api.get()
        value['preferences']['overrideLocalDNS'] = False
        with patch.object(client, 'request') as request:
            client.put(value)
            self.assertEqual(request.call_args.args[0], 'https://api.tailscale.com/api/v2/tailnet/-/dns/configuration')
            self.assertIs(request.call_args.kwargs['data']['preferences']['overrideLocalDNS'], False)

    def test_response_with_omitted_false_is_valid(self):
        response = {'nameservers': [{'address': '2606:1a40::7:9072:7912:0', 'useWithExitNode': True}],
                    'preferences': {'magicDNS': True}}
        value = monitor.normalize(response)
        self.assertIs(value['preferences']['overrideLocalDNS'], False)
        self.assertIs(value['preferences']['magicDNS'], True)
        self.assertEqual(value['splitDNS'], {})
        self.assertEqual(value['searchPaths'], [])
        monitor.check_profile(value, 'example')
        self.assertNotIn('overrideLocalDNS', response['preferences'])

    def test_normalization_handles_omitted_false_resolver_options(self):
        implicit = {'nameservers': [{'address': '1.1.1.1'}], 'preferences': {}}
        explicit = {'nameservers': [{'address': '1.1.1.1', 'useWithExitNode': False}],
                    'preferences': {'magicDNS': False, 'overrideLocalDNS': False},
                    'splitDNS': {}, 'searchPaths': []}
        self.assertEqual(monitor.normalize(implicit), monitor.normalize(explicit))
        with self.assertRaises(RuntimeError):
            monitor.normalize({'preferences': {'overrideLocalDNS': 'false'}})

    def test_profile_match_supports_encoded_ipv6_and_https(self):
        self.assertEqual(monitor.resolver_id('2606:1a40::7:9072:7912:0'), 'example')
        self.assertEqual(monitor.resolver_id('2606:1a40:1:0:7:9072:7912:0'), 'example')
        self.assertEqual(monitor.resolver_id('https://dns.controld.com/example'), 'example')
        self.assertIsNone(monitor.resolver_id('2606:4700:4700::1111'))
        self.assertIsNone(monitor.resolver_id('https://unrelated.example/profile'))
        self.assertIsNone(monitor.resolver_id('2606:1a40::22'))

    def test_mixed_global_nameservers_are_not_changed(self):
        self.api.value['nameservers'].append({'address': '1.1.1.1'})
        with self.assertRaises(RuntimeError):
            monitor.check_profile(self.api.value, 'profile')

    def test_dns_probe_rejects_failures_and_empty_or_blocked_answers(self):
        question = b'\x07example\x03com\0' + struct.pack('!HH', 1, 1)
        answer = b'\xc0\x0c' + struct.pack('!HHIH', 1, 1, 60, 4)
        header = struct.pack('!6H', 123, 0x8180, 1, 1, 0, 0)
        good = header + question + answer + b'\x01\x02\x03\x04'
        self.assertTrue(monitor.good_dns_answer(good, 123))
        self.assertFalse(monitor.good_dns_answer(good, 124))
        self.assertFalse(monitor.good_dns_answer(header + question + answer + b'\0\0\0\0', 123))
        self.assertFalse(monitor.good_dns_answer(good[:10], 123))
        for flags in (0x8182, 0x8183, 0x8380):
            self.assertFalse(monitor.good_dns_answer(struct.pack('!6H', 123, flags, 1, 1, 0, 0) + good[12:], 123))

    def test_real_client_normalizes_api_readback_for_update(self):
        client = monitor.Client({})
        client.token = 'test-token'
        current = monitor.normalize(self.api.get())
        desired_wire = copy.deepcopy(current)
        desired_wire['preferences'].pop('overrideLocalDNS')
        with patch.object(client, 'request', side_effect=[current, None, desired_wire]):
            monitor.update(client, current, False)


if __name__ == '__main__':
    unittest.main()
