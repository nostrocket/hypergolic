import unittest
from driver import CheckFailed, exactly_one, node_bounds, parse_nodes, is_increment, counter_value, outer_webview

class DriverObservationTests(unittest.TestCase):
    def test_old_scaffold_cannot_match_host_or_increment(self):
        nodes=parse_nodes('<hierarchy><node text="Hypergolic" bounds="[0,0][100,30]"/><node text="Development build" bounds="[0,30][100,50]"/></hierarchy>')
        self.assertFalse(any(n.get('text')=='Runtime connected' for n in nodes))
        with self.assertRaises(CheckFailed): exactly_one(nodes,is_increment,'Add one')
    def test_ambiguous_or_hidden_control_is_not_tapped(self):
        n={'text':'Add one','clickable':'true','bounds':'[10,20][40,50]'}
        with self.assertRaises(CheckFailed): exactly_one([n,n],is_increment,'Add one')
        with self.assertRaises(CheckFailed): node_bounds({'bounds':'[0,0][0,0]'})
    def test_outer_webview_uses_actual_xml_ancestry(self):
        nodes=parse_nodes('<hierarchy><node class="android.webkit.WebView" bounds="[1,2][99,199]"><node class="android.webkit.WebView" bounds="[1,2][100,200]"/></node></hierarchy>')
        self.assertEqual(node_bounds(outer_webview(nodes)),(1,2,99,199))
        nodes=parse_nodes('<hierarchy><node class="android.webkit.WebView" bounds="[1,2][99,199]"/><node class="android.webkit.WebView" bounds="[1,2][100,200]"/></hierarchy>')
        with self.assertRaises(CheckFailed): outer_webview(nodes)
    def test_counter_cannot_be_inferred_from_section_numbers(self):
        with self.assertRaises(CheckFailed): counter_value([{'text':'01'},{'text':'1'}])
        self.assertEqual(counter_value([{'resource-id':'counter','text':'3'}]),3)

if __name__=='__main__': unittest.main()
