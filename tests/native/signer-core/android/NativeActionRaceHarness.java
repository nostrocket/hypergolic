package org.nostrocket.hypergolic.identityowner;

import java.util.Map;

/** Test-only access to the actual native authentication authority, with public inventory fixtures. */
public final class NativeActionRaceHarness {
  private static final String SELECTED = "01".repeat(32), OTHER = "02".repeat(32);
  private final DeletionAuthority authority;
  private final String session, grant;
  private final DeletionAuthority.BackupLease backup;

  public NativeActionRaceHarness(boolean reading) {
    DeletionAuthority.Inventory inventory = new DeletionAuthority.Inventory("native_race_fixture", 1, SELECTED, "03".repeat(32),
      Map.of(SELECTED, "04".repeat(32), OTHER, "05".repeat(32)));
    authority = new DeletionAuthority(() -> inventory, () -> 100, () -> "native_race_token_0123456789");
    authority.activate(); authority.updateForeground(true);
    session = authority.beginSettings(SELECTED, 1);
    if (reading) {
      backup = authority.completeBackup(authority.beginBackup(session, SELECTED, SELECTED, 1), true);
      grant = null;
    } else {
      grant = authority.complete(authority.begin(session, OTHER, SELECTED, 1), true);
      backup = null;
    }
  }
  /** No secrets, OS credential changes or deletion effects: exact prompt and callback binding only. */
  public static int promptProof() {
    int count = 0;
    DeletionAuthority.Inventory inventory = new DeletionAuthority.Inventory("native_prompt_fixture", 1, SELECTED, "03".repeat(32),
      Map.of(SELECTED, "04".repeat(32), OTHER, "05".repeat(32), "06".repeat(32), "07".repeat(32)));
    DeletionAuthority authority = new DeletionAuthority(() -> inventory, () -> 100, () -> "native_prompt_token_0123456789");
    authority.activate(); authority.updateForeground(true);
    String session = authority.beginSettings(SELECTED, 1);
    DeletionAuthority.Attempt first = authority.begin(session, OTHER, SELECTED, 1);
    DeletionAuthority.Prompt firstPrompt = authority.prompt(first);
    if (!firstPrompt.description.contains(OTHER) || firstPrompt.description.contains(SELECTED)) throw new AssertionError("Prompt target mismatch");
    count++;
    if (!firstPrompt.description.contains("all its signing methods")) throw new AssertionError("Deletion operation missing");
    count++;
    authority.cancelAttempt(first);
    DeletionAuthority.Attempt second = authority.begin(session, "06".repeat(32), SELECTED, 1);
    DeletionAuthority.Prompt secondPrompt = authority.prompt(second);
    if (!secondPrompt.description.contains("06".repeat(32)) || secondPrompt.description.contains(OTHER)) throw new AssertionError("New prompt substituted");
    count++;
    if (!firstPrompt.description.contains(OTHER)) throw new AssertionError("Reserved prompt mutated");
    count++;
    try { authority.prompt(first); throw new AssertionError("Canceled prompt permitted"); } catch (DeletionAuthority.Denied expected) { count++; }
    try { authority.complete(first, true); throw new AssertionError("Late callback permitted"); } catch (DeletionAuthority.Denied expected) { count++; }
    if (!authority.canPresent(second)) throw new AssertionError("Late callback canceled current prompt");
    count++;
    String grant = authority.complete(second, true);
    try { authority.erase(session, OTHER, grant, target -> { throw new AssertionError("Wrong target erased"); });
      throw new AssertionError("Wrong target accepted"); } catch (DeletionAuthority.Denied expected) { count++; }
    authority.cancel(session);
    DeletionAuthority.Attempt local = authority.beginLocalRemoval(session, SELECTED, SELECTED, 1);
    DeletionAuthority.Prompt localPrompt = authority.prompt(local);
    if (!localPrompt.description.contains(SELECTED) || !localPrompt.description.contains("account and its data remain")
        || !localPrompt.description.contains("Back up this key")) throw new AssertionError("Local removal details missing");
    count++;
    authority.cancelAttempt(local);
    DeletionAuthority.Attempt backup = authority.beginBackup(session, SELECTED, SELECTED, 1);
    DeletionAuthority.Prompt backupPrompt = authority.prompt(backup);
    if (!backupPrompt.description.contains(SELECTED) || !backupPrompt.description.contains("Reveal the local private key")) throw new AssertionError("Backup target missing");
    count++;
    authority.cancelAttempt(backup);
    try { authority.begin(session, "08".repeat(32), SELECTED, 1); throw new AssertionError("Unknown prompt target permitted"); }
    catch (DeletionAuthority.Denied expected) { count++; }
    return count;
  }
  public void effect(Runnable beforeEffect, Runnable effect) {
    if (backup != null) {
      char[] result = authority.readBackup(backup, (target, digest) -> {
        beforeEffect.run(); effect.run(); return new char[63];
      });
      java.util.Arrays.fill(result, '\0');
    } else {
      authority.erase(session, OTHER, grant, target -> { beforeEffect.run(); effect.run(); });
    }
  }
  public void revoke(boolean background) {
    if (background) authority.updateForeground(false); else authority.vaultWillMutate();
  }
}
