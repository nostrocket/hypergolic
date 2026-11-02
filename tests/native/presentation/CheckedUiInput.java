package org.nostrocket.hypergolic.proof;
import com.android.uiautomator.core.Configurator;
import com.android.uiautomator.testrunner.UiAutomatorTestCase;
import org.w3c.dom.*;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.File;
import org.json.JSONObject;
import android.os.SystemClock;

/** Shell-UID physical input and observation, never application-state injection. */
public final class CheckedUiInput extends UiAutomatorTestCase {
 private final File snapshot=new File("/data/local/tmp/hg-checked-input.xml");
 private NodeList dump() throws Exception {
  long rootDeadline=SystemClock.uptimeMillis()+10000;
  do {
   if(snapshot.exists())assertTrue("Cannot remove previous owned snapshot",snapshot.delete());
   getUiDevice().dumpWindowHierarchy(snapshot.getName());
   if(snapshot.isFile() && snapshot.length()>0)break;
   sleep(100);
  } while(SystemClock.uptimeMillis()<rootDeadline);
  assertTrue("No fresh native hierarchy after bounded readiness",snapshot.isFile() && snapshot.length()>0);
  DocumentBuilderFactory f=DocumentBuilderFactory.newInstance();
  String xml=new String(java.nio.file.Files.readAllBytes(snapshot.toPath()),java.nio.charset.StandardCharsets.UTF_8);
  assertFalse("Unexpected XML declaration",xml.contains("<!DOCTYPE") || xml.contains("<!ENTITY"));
  return f.newDocumentBuilder().parse(snapshot).getElementsByTagName("node");
 }
 private Element target(NodeList nodes,String id) {
  Element found=null;
  for(int i=0;i<nodes.getLength();i++){
   Element n=(Element)nodes.item(i);
   if(id.equals(n.getAttribute("resource-id")) && "org.nostrocket.hypergolic.emptyacceptance".equals(n.getAttribute("package"))){
    if(found!=null) throw new AssertionError("Ambiguous native target: "+id);found=n;
   }
  }
  return found;
 }
 public void testAction() throws Exception {
  Configurator.getInstance().setWaitForIdleTimeout(0);getUiDevice().setCompressedLayoutHeirarchy(true);
  NodeList before=dump();String id=getParams().getString("target");String expected=getParams().getString("expected");
  if(id==null){System.out.println("CHECKED_UI_SNAPSHOT");return;}
  Element n=target(before,id);long readyDeadline=SystemClock.uptimeMillis()+10000;
  while(n==null && SystemClock.uptimeMillis()<readyDeadline){sleep(100);n=target(dump(),id);}
  assertNotNull("Native target absent after bounded observed readiness: "+id,n);
  assertEquals("true",n.getAttribute("enabled"));assertEquals("true",n.getAttribute("clickable"));
  java.util.regex.Matcher m=java.util.regex.Pattern.compile("\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]").matcher(n.getAttribute("bounds"));assertTrue(m.matches());
  int x1=Integer.parseInt(m.group(1)),y1=Integer.parseInt(m.group(2)),x2=Integer.parseInt(m.group(3)),y2=Integer.parseInt(m.group(4));
  assertTrue(x2>x1 && y2>y1);int x=(x1+x2)/2,y=(y1+y2)/2;
  assertTrue(x>=0 && x<getUiDevice().getDisplayWidth() && y>=0 && y<getUiDevice().getDisplayHeight());
  JSONObject receipt=new JSONObject().put("target",id).put("bounds",n.getAttribute("bounds")).put("x",x).put("y",y).put("beforeUptimeMillis",SystemClock.uptimeMillis());
  boolean accepted=getUiDevice().click(x,y);receipt.put("inputAccepted",accepted).put("afterInputUptimeMillis",SystemClock.uptimeMillis());
  System.out.println("CHECKED_UI_INPUT "+receipt.toString());assertTrue("Android rejected native click",accepted);
  assertNotNull("Expected native postcondition required",expected);
  long deadline=SystemClock.uptimeMillis()+8000;boolean observed=false;
  do { if(target(dump(),expected)!=null){observed=true;break;}sleep(100); } while(SystemClock.uptimeMillis()<deadline);
  receipt.put("expected",expected).put("postconditionObserved",observed).put("observedUptimeMillis",SystemClock.uptimeMillis());
  System.out.println("CHECKED_UI_RESULT "+receipt.toString());assertTrue("Delivered native click did not establish expected UI: "+expected,observed);
 }
}
