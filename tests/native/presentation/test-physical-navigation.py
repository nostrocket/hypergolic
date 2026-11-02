#!/usr/bin/env python3
"""Observer-only regression: clipped XML leaves retain their scroll direction."""
import importlib.util,sys,unittest,xml.etree.ElementTree as ET
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'tests/native/presentation'))
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,ROOT/'tests/native/presentation'/file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
MODULES=[load('namespace_observer','config-namespace-android.py'),load('notify_observer','notify-physical-android.py')]
class Navigation(unittest.TestCase):
 def observe(self,module,bounds,expected):
  journey=object.__new__(module.Journey);journey.report={'inputs':[]};journey.persist=lambda:None;journey.capture=lambda name:None;inputs=[]
  leaf=ET.Element('node',{'resource-id':'sdk-control','bounds':bounds,'class':'android.widget.Button','clickable':'true'})
  self.assertFalse(bool(leaf),'Regression must use a childless XML element')
  view=ET.Element('node',{'class':'android.webkit.WebView','bounds':'[100,100][900,1100]'})
  def nodes():
   current=ET.Element('node',dict(leaf.attrib))
   if inputs:current.set('bounds','[200,400][600,500]')
   journey.xml=ET.tostring(current);return [view,current]
  journey.nodes=nodes
  def adb(*args):inputs.append(args)
  journey.adb=adb;journey.guest_find('sdk-control')
  if expected is None:self.assertEqual(inputs,[])
  else:
   self.assertEqual(len(inputs),1)
   _,_,kind,_,start,_,end,_=inputs[0];self.assertEqual(kind,'swipe');self.assertEqual(int(end)>int(start),expected=='down')
 def test_clipped_leaf_above_scrolls_towards_top(self):
  for module in MODULES:
   with self.subTest(observer=module.__name__):self.observe(module,'[200,100][600,100]','down')
 def test_clipped_leaf_below_scrolls_towards_bottom(self):
  for module in MODULES:
   with self.subTest(observer=module.__name__):self.observe(module,'[200,1100][600,1100]','up')
 def test_visible_leaf_requires_no_scroll(self):
  for module in MODULES:
   with self.subTest(observer=module.__name__):self.observe(module,'[200,400][600,500]',None)
class NearEdgeNavigation(unittest.TestCase):
 def test_near_bottom_control_avoids_full_page_fling(self):
  module=MODULES[1];journey=object.__new__(module.Journey);journey.report={'inputs':[]};journey.persist=lambda:None;journey.capture=lambda name:None;inputs=[]
  view=ET.Element('node',{'class':'android.webkit.WebView','bounds':'[78,753][1202,2417]'})
  def nodes():
   target=ET.Element('node',{'resource-id':'sdk-control','bounds':'[156,2368][819,2417]' if not inputs else '[156,2200][819,2362]'})
   journey.xml=ET.tostring(target);return [view,target]
  journey.nodes=nodes;journey.adb=lambda *args:inputs.append(args);journey.guest_find('sdk-control');self.assertEqual(len(inputs),1)
  _,_,kind,_,start,_,end,duration=inputs[0];self.assertEqual(kind,'swipe');self.assertGreater(int(start),int(end));self.assertLessEqual(int(start)-int(end),250);self.assertGreaterEqual(int(duration),500)
class CardAttribution(unittest.TestCase):
 def card(self,foreign=False):
  module=MODULES[1];journey=object.__new__(module.Journey);publisher=module.base.npub(module.PUBLISHER)
  card=ET.Element('node',{'resource-id':'notify-card-first','bounds':'[100,100][900,700]'})
  source=ET.Element('node',{'text':'From routing-lab','bounds':'[120,120][800,180]'})
  origin=ET.Element('node',{'text':'foreign-publisher' if foreign else publisher,'bounds':'[120,200][800,260]'})
  click=ET.Element('node',{'resource-id':'notify-click-first','content-desc':'Routing Lab alert\nExact SDK notification + ⚡','bounds':'[120,300][800,420]'})
  badge=ET.Element('node',{'resource-id':'notify-badge-routing-lab','bounds':'[100,750][900,1050]'})
  adjacent=ET.Element('node',{'text':publisher,'bounds':'[120,800][800,900]'})
  all_nodes=[card,source,origin,click,badge,adjacent,ET.Element('node',{'text':'Notifications','bounds':'[100,20][500,80]'})];journey.tap=lambda label:None;journey.nodes=lambda:all_nodes;journey.report={}
  def find(label):
   matches=[n for n in all_nodes if label in (n.get('resource-id'),n.get('text'),n.get('content-desc'))]
   if len(matches)!=1:raise AssertionError('Ambiguous or absent native control: '+label)
   return matches[0]
  journey.find=find;return journey
 def test_badge_publisher_duplicate_does_not_hide_exact_card_origin(self):
  self.card().centre('first')
 def test_badge_publisher_cannot_supply_foreign_card_origin(self):
  with self.assertRaises(AssertionError):self.card(foreign=True).centre('first')
class ViewportReadiness(unittest.TestCase):
 def observer(self):
  journey=object.__new__(MODULES[1].Journey);journey.report={};journey.xml=b'initial-native-layout';journey.persist=lambda:None;return journey
 def test_transient_empty_viewport_waits_for_exact_native_frame(self):
  journey=self.observer();views=[ET.Element('node',{'class':'android.webkit.WebView','bounds':'[100,100][900,1100]'})];journey.nodes=lambda:views;self.assertEqual(journey.guest_viewport([]),(100,100,900,1100));self.assertEqual(len(journey.report['unsettledGuestFrames']),1)
 def test_nested_one_pixel_rounding_uses_shared_visible_intersection(self):
  journey=self.observer();outer=ET.Element('node',{'class':'android.webkit.WebView','bounds':'[78,753][1202,2617]'});inner=ET.SubElement(outer,'node',{'class':'android.webkit.WebView','bounds':'[78,753][1202,2618]'})
  self.assertEqual(journey.guest_viewport([outer,inner]),(78,753,1202,2617));self.assertEqual(len(journey.report['nestedGuestFrameRounding']),1)
 def test_one_pixel_siblings_are_still_ambiguous(self):
  journey=self.observer();views=[ET.Element('node',{'class':'android.webkit.WebView','bounds':bounds}) for bounds in ['[78,753][1202,2617]','[78,753][1202,2618]']];journey.nodes=lambda:views
  with self.assertRaises(AssertionError):journey.guest_viewport(views)
 def test_nested_materially_different_frames_remain_ambiguous(self):
  journey=self.observer();outer=ET.Element('node',{'class':'android.webkit.WebView','bounds':'[78,753][1202,2617]'});inner=ET.SubElement(outer,'node',{'class':'android.webkit.WebView','bounds':'[78,800][1202,2617]'});journey.nodes=lambda:[outer,inner]
  with self.assertRaises(AssertionError):journey.guest_viewport([outer,inner])
 def test_unsettled_distinct_viewports_do_not_select_an_arbitrary_frame(self):
  journey=self.observer();views=[ET.Element('node',{'class':'android.webkit.WebView','bounds':bounds}) for bounds in ['[100,100][900,500]','[100,600][900,1100]']];journey.nodes=lambda:views
  with self.assertRaises(AssertionError):journey.guest_viewport(views)
if __name__=='__main__':unittest.main()
