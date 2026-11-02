import expo.modules.securestore.NappletConfigPolicy;

public final class ConfigPolicyProof {
  private static int cases;
  private static final String KEY = "scope." + "a1".repeat(32);
  private static void check(boolean result) {
    cases++;
    if (!result) throw new AssertionError("Policy case " + cases);
  }
  private static boolean accepts(String key, String service, boolean auth, String prompt, int access, String group) {
    return NappletConfigPolicy.allows(key, service, auth, prompt, access, group);
  }
  public static void main(String[] args) {
    if (args.length == 2) {
      if (!accepts(args[0], args[1], false, " ", 6, null)) throw new SecurityException("Restricted namespace");
      return;
    }
    check(accepts(KEY, NappletConfigPolicy.SERVICE, false, " ", 6, null));
    for (String key : new String[]{"inventory", "secret.a", "stage.a", "scope.", KEY + "a", KEY.substring(1), KEY.toUpperCase(), KEY + "\n", KEY.replace('a', 'g'), "scope." + "é".repeat(64), " " + KEY, null})
      check(!accepts(key, NappletConfigPolicy.SERVICE, false, " ", 6, null));
    for (String service : new String[]{"app", "key_v1", "org.nostrocket.hypergolic.identity.v1", NappletConfigPolicy.SERVICE + ":no-auth", NappletConfigPolicy.SERVICE + ":auth", "", null})
      check(!accepts(KEY, service, false, " ", 6, null));
    check(!accepts(KEY, NappletConfigPolicy.SERVICE, true, " ", 6, null));
    for (String prompt : new String[]{"", "Confirm", null}) check(!accepts(KEY, NappletConfigPolicy.SERVICE, false, prompt, 6, null));
    for (int access = -1; access < 9; access++) if (access != 6) check(!accepts(KEY, NappletConfigPolicy.SERVICE, false, " ", access, null));
    for (String group : new String[]{"", "other.group"}) check(!accepts(KEY, NappletConfigPolicy.SERVICE, false, " ", 6, group));
    check(NappletConfigPolicy.allowsRecord("aes", NappletConfigPolicy.SERVICE, false, true));
    Object[][] records = {
      {"hybrid", NappletConfigPolicy.SERVICE, false, true},
      {null, NappletConfigPolicy.SERVICE, false, true},
      {"aes", "org.nostrocket.hypergolic.identity.v1", false, true},
      {"aes", null, false, true},
      {"aes", NappletConfigPolicy.SERVICE, true, true},
      {"aes", NappletConfigPolicy.SERVICE, null, true},
      {"aes", NappletConfigPolicy.SERVICE, "false", true},
      {"aes", NappletConfigPolicy.SERVICE, false, false},
      {"aes", NappletConfigPolicy.SERVICE, false, null},
      {"aes", NappletConfigPolicy.SERVICE, false, "true"}
    };
    for (Object[] record : records) check(!NappletConfigPolicy.allowsRecord(record[0], record[1], record[2], record[3]));
    System.out.println("Android owning native policy: " + cases + " cases passed");
  }
}
