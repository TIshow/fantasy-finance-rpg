// 外側とのつなぎ目の契約：時計。型だけで、実装は置かない（実装は呼び出し側の層が持つ）。
// src/ledger と src/events は時計を持たない。時刻は引数で受け取る（AGENTS.md）。

/** 現在時刻を返す口。単位は events/types.ts の recordedAt と同じ（UNIXミリ秒の整数） */
export interface Clock {
  now(): number;
}
