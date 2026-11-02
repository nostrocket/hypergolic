import copy
import json
import unittest
from observations import correlate_counter, common_increment, same_instances, assert_state, require_two_columns, native_focus, target_at_native_bounds
from driver import CheckFailed

def target(key):
    return {'id':key,'generation':'generation-'+key,'frameId':'frame-'+key,'contextUniqueId':'context-'+key,
      'snapshot':{'counter':'0','draft':'','mirror':'No text yet.','selected':'None','edge':'None',
      'scroll':{'x':0,'y':0,'rail':0},'viewport':{'width':300,'height':600},
      'controls':{'increment':{'x':100,'y':200,'width':100,'height':48}}}}

class ObservationTests(unittest.TestCase):
    def test_target_geometry_uses_exact_native_bounds_not_list_order_or_visible_flag(self):
        rows=[target('offscreen'),target('focused')]
        for index,row in enumerate(rows):
            row['description']=json.dumps({'attached':True,'empty':False,'visible':True,'screenX':110 if index==0 else 10,'screenY':50,'width':100,'height':600})
        self.assertEqual(target_at_native_bounds(rows,(10,50,110,650))['id'],'focused')
        with self.assertRaises(CheckFailed):target_at_native_bounds(rows,(30,50,130,650))
        rows[0]['description']=rows[1]['description']
        with self.assertRaises(CheckFailed):target_at_native_bounds(rows,(10,50,110,650))

    def test_correlates_only_the_single_causally_changed_target(self):
        before=[target('first'),target('second'),target('third')]
        after=copy.deepcopy(before)
        after[1]['snapshot']['counter']='1'
        self.assertEqual(correlate_counter(before,after)['id'],'second')

    def test_correlation_rejects_unchanged_double_increment_or_multiple_changes(self):
        before=[target('first'),target('second')]
        for counters in [('0','0'),('2','0'),('1','1')]:
            after=copy.deepcopy(before)
            for row,counter in zip(after,counters): row['snapshot']['counter']=counter
            with self.assertRaises(CheckFailed): correlate_counter(before,after)

    def test_recreated_context_cannot_masquerade_as_retained_state(self):
        before=[target('first')]
        for field in ('id','generation','frameId','contextUniqueId'):
            after=copy.deepcopy(before);after[0][field]='replacement'
            with self.assertRaises(CheckFailed): same_instances(before,after)

    def test_other_fixture_draft_change_rejects_correlation(self):
        before=[target('first'),target('second')];after=copy.deepcopy(before)
        after[0]['snapshot']['counter']='1';after[1]['snapshot']['draft']='changed'
        with self.assertRaises(CheckFailed): correlate_counter(before,after)

    def test_coordinate_requires_identical_visible_candidate_controls(self):
        rows=[target('first'),target('second')]
        self.assertEqual(common_increment(rows)[1]['x'],100)
        rows[1]['snapshot']['controls']['increment']['x']=99
        with self.assertRaises(CheckFailed): common_increment(rows)
        rows=[target('first')];rows[0]['snapshot']['controls']['increment']['y']=599
        with self.assertRaises(CheckFailed): common_increment(rows)

    def test_retention_checks_both_axes_and_inner_horizontal_rail(self):
        expected=target('a')['snapshot']
        for axis in ('x','y','rail'):
            actual=copy.deepcopy(expected);actual['scroll'][axis]=20
            with self.assertRaises(CheckFailed): assert_state(expected,actual)

    def test_two_columns_cannot_pass_single_column_or_reordered_row(self):
        make=lambda title,bounds:{'content-desc':'Open '+title,'bounds':bounds}
        good=[make('UX Lab 1','[10,100][140,300]'),make('UX Lab 2','[160,100][290,300]'),make('UX Lab 3','[10,350][140,550]')]
        self.assertEqual(len(require_two_columns(good,['UX Lab 1','UX Lab 2','UX Lab 3'])),3)
        good[1]['bounds']='[10,350][140,550]'
        with self.assertRaises(CheckFailed):require_two_columns(good,['UX Lab 1','UX Lab 2'])

    def test_inactive_native_accessibility_leak_is_a_failure(self):
        nodes=[{'resource-id':'focused-napplet-name','text':'UX Lab 1','bounds':'[0,0][50,50]'},
          {'resource-id':'runtime-status-ux-lab-1','text':'Runtime connected','bounds':'[0,700][100,720]'},
          {'class':'android.webkit.WebView','_webview-depth':0,'bounds':'[0,50][100,700]'}]
        self.assertEqual(native_focus(nodes)['sessionId'],'ux-lab-1')
        nodes.append({'resource-id':'runtime-status-ux-lab-2','text':'Runtime connected','bounds':'[0,700][100,720]'})
        with self.assertRaises(CheckFailed):native_focus(nodes)

    def test_zero_area_dump_entries_are_recorded_separately_not_mistaken_for_focus(self):
        nodes=[{'resource-id':'focused-napplet-name','text':'UX Lab 1','bounds':'[0,0][50,50]'},
          {'resource-id':'runtime-status-ux-lab-1','text':'Runtime connected','bounds':'[0,700][100,720]'},
          {'resource-id':'runtime-status-ux-lab-2','text':'Runtime connected','bounds':'[100,700][100,720]'},
          {'class':'android.webkit.WebView','_webview-depth':0,'bounds':'[0,50][100,700]'},
          {'class':'android.webkit.WebView','_webview-depth':0,'bounds':'[100,50][100,700]'}]
        observed=native_focus(nodes)
        self.assertEqual(observed['sessionId'],'ux-lab-1')
        self.assertEqual(len(observed['nonvisibleStatusesInFullDump']),1)

    def test_glass_opt_in_requires_one_visible_native_surface(self):
        nodes=[{'resource-id':'focused-napplet-name','text':'UX Lab 1','bounds':'[0,0][50,50]'},
          {'class':'android.webkit.WebView','_webview-depth':0,'bounds':'[0,50][100,700]'}]
        with self.assertRaises(CheckFailed): native_focus(nodes)
        self.assertEqual(native_focus(nodes, require_status=False)['sessionId'], 'ux-lab-1')
        nodes.append({'class':'android.webkit.WebView','_webview-depth':0,'bounds':'[100,50][200,700]'})
        with self.assertRaises(CheckFailed): native_focus(nodes, require_status=False)

    def test_glass_opt_in_still_rejects_conflicting_status(self):
        nodes=[{'resource-id':'focused-napplet-name','text':'UX Lab 1','bounds':'[0,0][50,50]'},
          {'class':'android.webkit.WebView','_webview-depth':0,'bounds':'[0,50][100,700]'},
          {'resource-id':'runtime-status-ux-lab-2','text':'Runtime connected','bounds':'[0,700][100,720]'}]
        with self.assertRaises(CheckFailed): native_focus(nodes, require_status=False)

if __name__=='__main__':unittest.main()
