#!/usr/bin/env python3
"""Exact-publisher native permission selection; never borrow adjacent row controls."""
import importlib.util,sys,unittest,xml.etree.ElementTree as ET
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'tests/native/presentation'))
spec=importlib.util.spec_from_file_location('publisher_observer',ROOT/'tests/native/presentation/notify-publisher-physical-android.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
def node(text,bounds,**attrs):return ET.Element('node',{'text':text,'bounds':bounds,**attrs})
class PublisherSelection(unittest.TestCase):
 def rows(self):
  return [node('same-app','[20,100][400,140]'),node('publisher-one','[20,150][900,200]'),node('General notifications','[20,210][600,240]'),node('Revoke notification permission','[20,250][900,300]',**{'resource-id':'notify-revoke-same-app-general','clickable':'true','enabled':'true'}),node('same-app','[20,350][400,390]'),node('publisher-two','[20,400][900,450]'),node('General notifications','[20,460][600,490]'),node('Revoke notification permission','[20,500][900,550]',**{'resource-id':'notify-revoke-same-app-general','clickable':'true','enabled':'true'})]
 def test_same_app_revoke_buttons_bind_to_their_distinct_publishers(self):
  rows=self.rows();self.assertIs(module.permission_button(rows,'publisher-one','same-app',''),rows[3]);self.assertIs(module.permission_button(rows,'publisher-two','same-app',''),rows[7])
 def test_clipped_target_button_cannot_borrow_visible_next_publisher_button(self):
  rows=self.rows();rows[3].set('bounds','[0,0][0,0]')
  with self.assertRaises(AssertionError):module.permission_button(rows,'publisher-one','same-app','')
 def test_disabled_target_button_cannot_select_adjacent_publisher(self):
  rows=self.rows();rows[3].set('enabled','false')
  with self.assertRaises(AssertionError):module.permission_button(rows,'publisher-one','same-app','')
if __name__=='__main__':unittest.main()
