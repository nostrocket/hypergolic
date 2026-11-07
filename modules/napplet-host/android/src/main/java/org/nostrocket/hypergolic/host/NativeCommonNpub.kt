package org.nostrocket.hypergolic.host

/** NIP19 public npub only: exact checksum and 32-byte payload, never a private key. */
internal object NativeCommonNpub {
  private const val alphabet="qpzry9x8gf2tvdw0s3jn54khce6mua7l"
  fun publicKey(value:String):String=if(value.matches(Regex("[0-9a-f]{64}")))value else decode(value)
  fun decode(input:String):String {
    require(input.length==63&&(input==input.lowercase()||input==input.uppercase()))
    val value=input.lowercase();require(value.startsWith("npub1"))
    val data=value.drop(5).map { alphabet.indexOf(it).also { n->require(n>=0) } }
    var checksum=1
    for(number in listOf(3,3,3,3,0,14,16,21,2)+data){
      val high=checksum ushr 25;checksum=((checksum and 0x1ffffff) shl 5) xor number
      for(i in 0..4)if((high ushr i)and 1!=0)checksum=checksum xor intArrayOf(0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3)[i]
    }
    require(checksum==1)
    var accumulator=0;var bits=0;val bytes=mutableListOf<Int>()
    for(number in data.dropLast(6)){accumulator=((accumulator shl 5)or number)and 0xffff;bits+=5;while(bits>=8){bits-=8;bytes.add((accumulator ushr bits)and 255)}}
    require(bytes.size==32&&bits<5&&((accumulator shl(8-bits))and 255)==0)
    return bytes.joinToString(""){"%02x".format(it)}
  }
}
