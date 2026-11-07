import {MapPbfReader,MapPbfError} from './resource-pbf-wire.ts';
import {validateGlyphPbf} from './resource-glyph-pbf.ts';
import {validateVectorPbf} from './resource-vector-pbf.ts';
/** No extension/header authority and no generic Protobuf fallback. */
export function classifyMapPbf(bytes:Uint8Array):string|undefined {
  if(bytes[0]!==10 && bytes[0]!==26)return undefined;
  try {
    if(bytes[0]===10){validateGlyphPbf(new MapPbfReader(bytes));return 'application/x-protobuf';}
    validateVectorPbf(new MapPbfReader(bytes));return 'application/vnd.mapbox-vector-tile';
  } catch(error) {if(error instanceof MapPbfError)return undefined;throw error;}
}
