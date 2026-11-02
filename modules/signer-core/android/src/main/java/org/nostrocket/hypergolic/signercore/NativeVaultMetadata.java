package org.nostrocket.hypergolic.signercore;

import org.json.JSONArray;
import org.json.JSONObject;
import org.nostrocket.hypergolic.signercore.NativeVaultRecordCodec.Record;
import org.nostrocket.hypergolic.signercore.NativeVaultRecordCodec.State;
import org.nostrocket.hypergolic.signercore.NativeVault.Error;
import static org.nostrocket.hypergolic.signercore.NativeVault.*;

/** The complete public metadata allowlist. Scalars and transport handles have no representation here. */
final class NativeVaultMetadata {
  static String snapshot(State value) {
    try {
      JSONArray records = new JSONArray();
      for (Record record:value.records) records.put(new JSONObject().put("pubkey",record.pubkey).put("addedAt",record.addedAt)
        .put("origin",record.origin==0?"generated":record.origin==1?"imported":"connected").put("status","active"));
      return new JSONObject().put("vaultId",value.id).put("revision",value.revision).put("selectedPubkey",value.selected)
        .put("identities",records).put("pendingDeletion",JSONObject.NULL).toString();
    } catch (Exception failure) { throw new Error("CORRUPT_METADATA"); }
  }
  static String methods(State current, Record value) {
    try {
      JSONArray methods = new JSONArray();
      if (value.key != null) methods.put(new JSONObject().put("kind", "local"));
      if (value.remote != null) methods.put(new JSONObject().put("kind", "nip46")
        .put("peerPubkey", value.remote.peer).put("relays", new JSONArray(value.remote.relays)));
      if (value.androidSigner != null) methods.put(new JSONObject().put("kind", "nip55").put("packageName", value.androidSigner.packageName)
        .put("certificateSha256s", new JSONArray(value.androidSigner.certificateSha256s)));
      Object selected = value.method == LOCAL ? "local" : value.method == NIP46 ? "nip46" : value.method == NIP55 ? "nip55" : JSONObject.NULL;
      return new JSONObject().put("vaultId", current.id).put("revision", current.revision).put("pubkey", value.pubkey)
        .put("selectedMethod", selected).put("methods", methods).toString();
    } catch (Exception failure) { throw new Error("CORRUPT_METADATA"); }
  }
}
