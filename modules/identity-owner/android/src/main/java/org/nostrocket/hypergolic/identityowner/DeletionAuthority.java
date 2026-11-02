package org.nostrocket.hypergolic.identityowner;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/** Native-only identity action authority. No exported Expo method accepts an inventory or auth result. */
final class DeletionAuthority {
  static final long MAX_REVISION = 9_007_199_254_740_991L;
  static final long AUTH_MILLIS = 60_000L;
  static final long GRANT_MILLIS = 15_000L;
  static final long REVEAL_MILLIS = 60_000L;
  interface BackupReader { char[] read(String target, String expectedDigest); }
  static final class Denied extends RuntimeException {
    Denied() { super("Identity action unavailable"); }
  }
  interface InventoryReader { Inventory read(); }
  /** Synchronous native erase/readback, with no callbacks into this authority. */
  interface Erase { void run(String target); }

  static final class Inventory {
    final String vault, selected, receiptDigest;
    final long revision;
    final Map<String, String> identities;
    Inventory(String vault, long revision, String selected, String receiptDigest, Map<String, String> identities) {
      require(vault != null && vault.matches("[A-Za-z0-9_-]{16,80}") && revision > 0 && revision <= MAX_REVISION && key(selected) && key(receiptDigest));
      require(identities != null && !identities.isEmpty() && identities.size() <= 16);
      Map<String, String> copy = new HashMap<>(identities);
      require(copy.containsKey(selected));
      for (Map.Entry<String, String> item : copy.entrySet()) require(key(item.getKey()) && key(item.getValue()));
      this.vault = vault; this.revision = revision; this.selected = selected; this.receiptDigest = receiptDigest;
      this.identities = Collections.unmodifiableMap(copy);
    }
    @Override public boolean equals(Object other) {
      if (!(other instanceof Inventory)) return false;
      Inventory value = (Inventory) other;
      return revision == value.revision && vault.equals(value.vault) && selected.equals(value.selected)
          && receiptDigest.equals(value.receiptDigest) && identities.equals(value.identities);
    }
    @Override public int hashCode() { return Objects.hash(vault, revision, selected, receiptDigest, identities); }
  }
  static final class Attempt {
    private final Object owner;
    private final long epoch, deadline;
    private final String session, target;
    private final Inventory inventory;
    private final boolean backup, localRemoval;
    private Attempt(DeletionAuthority authority, long deadline, String target, boolean backup, boolean localRemoval) {
      this.owner = authority.owner; this.epoch = authority.epoch; this.deadline = deadline;
      this.session = authority.session; this.target = target; this.inventory = authority.inventory; this.backup = backup; this.localRemoval = localRemoval;
    }
  }
  /** Public account text captured from the reserved native attempt, never a mutable UI target. */
  static final class Prompt {
    final String title, explanation, description;
    private Prompt(Attempt value) {
      title = value.backup ? "Back up identity" : value.localRemoval ? "Remove local private key" : "Delete saved identity";
      explanation = value.backup ? "Authenticate to reveal this identity’s private key"
          : value.localRemoval ? "Authenticate to remove this identity’s local private key"
          : "Authenticate to delete this identity and all its signing methods";
      String operation = value.backup ? "Reveal the local private key for this account."
          : value.localRemoval ? "Remove only the local private key. The account and its data remain. Back up this key before removing it."
          : "Delete this saved account and all its signing methods.";
      description = "Account public key:\n" + value.target + "\n\n" + operation;
    }
  }
  private static final class Grant {
    final Attempt attempt;
    final String token;
    final long deadline;
    Grant(Attempt attempt, String token, long deadline) { this.attempt = attempt; this.token = token; this.deadline = deadline; }
  }

  /** Native object identity only; never serialized or returned over the bridge. */
  static final class BackupLease {
    private final Attempt attempt;
    private final long deadline;
    private boolean read;
    private BackupLease(Attempt attempt, long deadline) { this.attempt = attempt; this.deadline = deadline; }
  }

  private final InventoryReader reader;
  private final LongSupplier clock;
  private final Supplier<String> entropy;
  private final Object owner = new Object();
  private boolean activated, retired, foreground, opening;
  private long epoch;
  private Inventory inventory;
  private String session;
  private Attempt attempt;
  private Grant grant;
  private BackupLease backupLease;

  DeletionAuthority(InventoryReader reader, LongSupplier clock, Supplier<String> entropy) {
    this.reader = Objects.requireNonNull(reader); this.clock = Objects.requireNonNull(clock); this.entropy = Objects.requireNonNull(entropy);
  }
  private static void require(boolean accepted) { if (!accepted) throw new Denied(); }
  static boolean key(String value) { return value != null && value.matches("[0-9a-f]{64}"); }
  static boolean opaque(String value) { return value != null && value.matches("[A-Za-z0-9_-]{16,128}"); }
  private long now() { long value = clock.getAsLong(); require(value >= 0); return value; }
  private long deadline(long lifetime) { long value = now(); require(value <= Long.MAX_VALUE - lifetime); return value + lifetime; }
  private String token() { String value = entropy.get(); require(opaque(value)); return value; }
  private void available() { require(activated && !retired && foreground && epoch < Long.MAX_VALUE); }
  private void invalidate() {
    if (epoch == Long.MAX_VALUE) retired = true; else epoch++;
    inventory = null; session = null; attempt = null; grant = null; backupLease = null;
  }
  /** Called once after the exact native AppContext's process claim succeeds. */
  synchronized void activate() { require(!activated && !retired); activated = true; }
  /** Resume never restores a previous Settings session. OS prompt inactivity is not background. */
  synchronized void updateForeground(boolean value) {
    foreground = value;
    if (!value) invalidate();
  }
  synchronized void retire() { retired = true; invalidate(); }
  synchronized void vaultWillMutate() { invalidate(); }
  synchronized void endSettings(String expectedSession) {
    if (session != null && session.equals(expectedSession)) invalidate();
  }
  synchronized void cancel(String expectedSession) {
    if (session != null && session.equals(expectedSession)) { attempt = null; grant = null; backupLease = null; }
  }
  /** Late timeout/coroutine cleanup must never cancel a newer attempt in the same Settings session. */
  synchronized void cancelAttempt(Attempt value) {
    if (value == null) return;
    if (attempt == value) attempt = null;
    if (grant != null && grant.attempt == value) grant = null;
    if (backupLease != null && backupLease.attempt == value) backupLease = null;
  }
  private boolean matches(Attempt value) {
    return activated && !retired && foreground && value.owner == owner && value.epoch == epoch
        && value.session.equals(session) && value.inventory.equals(inventory);
  }
  private void compareCurrent(Inventory fresh) {
    if (!Objects.equals(inventory, fresh)) { invalidate(); throw new Denied(); }
  }
  String beginSettings(String expectedSelected, long expectedRevision) {
    final long reserved;
    synchronized (this) {
      available(); require(!opening); require(key(expectedSelected) && expectedRevision > 0 && expectedRevision <= MAX_REVISION);
      invalidate(); available(); opening = true; reserved = epoch;
    }
    try {
      Inventory fresh = reader.read();
      String newSession = token();
      synchronized (this) {
        available(); require(epoch == reserved && fresh != null && fresh.selected.equals(expectedSelected) && fresh.revision == expectedRevision);
        inventory = fresh; session = newSession; return newSession;
      }
    } finally { synchronized (this) { opening = false; } }
  }
  synchronized Attempt begin(String expectedSession, String target, String expectedSelected, long expectedRevision) {
    return beginAction(expectedSession, target, expectedSelected, expectedRevision, false, false);
  }
  synchronized Attempt beginBackup(String expectedSession, String target, String expectedSelected, long expectedRevision) {
    return beginAction(expectedSession, target, expectedSelected, expectedRevision, true, false);
  }
  synchronized Attempt beginLocalRemoval(String expectedSession, String target, String expectedSelected, long expectedRevision) {
    return beginAction(expectedSession, target, expectedSelected, expectedRevision, false, true);
  }
  private Attempt beginAction(String expectedSession, String target, String expectedSelected, long expectedRevision, boolean backup, boolean localRemoval) {
    available(); require(!opening && opaque(expectedSession) && key(target) && inventory != null && expectedSession.equals(session));
    require(inventory.selected.equals(expectedSelected) && inventory.revision == expectedRevision);
    compareCurrent(reader.read());
    if (grant != null && now() >= grant.deadline) grant = null;
    if (attempt != null && now() >= attempt.deadline) attempt = null;
    if (backupLease != null && now() >= backupLease.deadline) backupLease = null;
    require(attempt == null && grant == null && backupLease == null && inventory.identities.containsKey(target));
    require(backup || localRemoval ? target.equals(inventory.selected) : inventory.identities.size() >= 2 && !target.equals(inventory.selected));
    attempt = new Attempt(this, deadline(AUTH_MILLIS), target, backup, localRemoval);
    return attempt;
  }
  synchronized boolean canPresent(Attempt value) {
    return value != null && value == attempt && matches(value) && now() < value.deadline;
  }
  synchronized Prompt prompt(Attempt value) {
    require(canPresent(value));
    return new Prompt(value);
  }
  /** Native OS-auth callback only; complete exactly the reserved attempt, never a caller-selected ID. */
  synchronized String complete(Attempt value, boolean authenticated) {
    require(value != null && value == attempt);
    attempt = null; // A failed, stale or repeated callback cannot be retried into a grant.
    require(!value.backup && authenticated && matches(value) && now() < value.deadline);
    compareCurrent(reader.read());
    String next = token();
    // Entropy can fail. Do not leave the attempt active, and do not issue an unbounded grant.
    require(matches(value) && now() < value.deadline);
    grant = new Grant(value, next, deadline(GRANT_MILLIS));
    return next;
  }
  synchronized BackupLease completeBackup(Attempt value, boolean authenticated) {
    require(value != null && value == attempt);
    attempt = null;
    require(value.backup && authenticated && matches(value) && now() < value.deadline);
    compareCurrent(reader.read());
    require(matches(value) && now() < value.deadline);
    backupLease = new BackupLease(value, deadline(REVEAL_MILLIS));
    return backupLease;
  }
  synchronized boolean canReveal(BackupLease value) {
    return value != null && value == backupLease && matches(value.attempt) && now() < value.deadline;
  }
  synchronized void closeBackup(BackupLease value) {
    if (value != null && backupLease == value) backupLease = null;
  }
  /** One native read, revalidated after I/O; denied output is wiped before unwinding. */
  synchronized char[] readBackup(BackupLease value, BackupReader effect) {
    require(canReveal(value) && !value.read);
    value.read = true;
    char[] secret = null;
    try {
      compareCurrent(reader.read());
      require(canReveal(value));
      secret = effect.read(value.attempt.target, value.attempt.inventory.identities.get(value.attempt.target));
      compareCurrent(reader.read());
      require(canReveal(value) && secret != null && secret.length == 63);
      return secret;
    } catch (RuntimeException error) {
      if (secret != null) Arrays.fill(secret, '\0');
      closeBackup(value);
      throw new Denied();
    }
  }
  private Grant validate(String expectedSession, String target, String expectedToken) {
    require(opaque(expectedSession) && key(target) && opaque(expectedToken));
    Grant value = grant;
    require(value != null && !value.attempt.backup && value.token.equals(expectedToken) && value.attempt.target.equals(target)
        && value.attempt.session.equals(expectedSession) && matches(value.attempt) && now() < value.deadline);
    return value;
  }
  synchronized void assertActive(String expectedSession, String target, String expectedToken) {
    validate(expectedSession, target, expectedToken);
  }
  /** Bridge erasure accepts only target/token; the Settings owner comes from native grant state. */
  synchronized void eraseAuthorized(String target, String expectedToken, Erase effect) {
    require(grant != null);
    erase(grant.attempt.session, target, expectedToken, effect);
  }
  /** Inventory is re-read at the actual effect. Revocation and erase serialize on this monitor. */
  synchronized void erase(String expectedSession, String target, String expectedToken, Erase effect) {
    validate(expectedSession, target, expectedToken);
    compareCurrent(reader.read());
    validate(expectedSession, target, expectedToken);
    grant = null; // Consume before the effect; an uncertain or failed commit requires new authentication.
    effect.run(target);
  }
}
