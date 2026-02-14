export interface BitcoinTransactionStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}

export interface BitcoinTransactionPrevout {
  scriptpubkey: string;
  scriptpubkey_asm: string;
  scriptpubkey_type: string;
  scriptpubkey_address: string;
  value: number;
}

export interface BitcoinTransactionVin {
  txid: string;
  vout: number;
  prevout: BitcoinTransactionPrevout;
  scriptsig: string;
  scriptsig_asm: string;
  witness: string[];
  is_coinbase: boolean;
  sequence: number;
}

export interface BitcoinTransactionVout {
  scriptpubkey: string;
  scriptpubkey_asm: string;
  scriptpubkey_type: string;
  scriptpubkey_address: string;
  value: number;
}

export interface BitcoinTransaction {
  txid: string;
  version: number;
  locktime: number;
  vin: BitcoinTransactionVin[];
  vout: BitcoinTransactionVout[];
  size: number;
  weight: number;
  fee: number;
  status: BitcoinTransactionStatus;
}

export type BitcoinAddressTransactions = BitcoinTransaction[];
