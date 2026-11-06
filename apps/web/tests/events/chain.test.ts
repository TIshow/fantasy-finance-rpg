// docs/EVENT_LOG.md §5 の正規化・ハッシュ・連鎖を確かめる。
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/events/canonical";
import { verifyChain, sealEvent } from "../../src/events/chain";
import { accountHash, bodyHash, eventHash, sha256Hex } from "../../src/events/hash";
import { GENESIS_HASH, type EventDraft, type LogEvent } from "../../src/events/types";

const draft = (over: Partial<EventDraft> = {}): EventDraft => ({
  type: "agent.registered",
  recordedAt: 1_793_580_000_000,
  actor: "operator:owner",
  keys: [],
  refs: [],
  payload: { agentId: "alpha" },
  ...over,
});

async function chain(n: number): Promise<LogEvent[]> {
  const out: LogEvent[] = [];
  for (let i = 0; i < n; i++) out.push(await sealEvent(out.at(-1) ?? null, draft({ recordedAt: 1_793_580_000_000 + i, keys: [`k:${i}`], refs: i > 0 ? [i] : [] })));
  return out;
}

describe("RFC 8785 の正規化", () => {
  it("キーを UTF-16 の符号単位の順に並べる（RFC 8785 §3.2.3 の例）", () => {
    // 例のうち U+FB33 は NFC で別の文字（U+05D3 U+05BC）になるので、ここでは拒否されることだけを確かめる
    const v = { "\u20ac": 1, "\r": 2, "1": 4, "\ud83d\ude00": 5, "\u0080": 6, "\u00f6": 7 };
    expect(canonicalize(v)).toBe('{"\\r":2,"1":4,"\u0080":6,"\u00f6":7,"\u20ac":1,"\ud83d\ude00":5}');
    expect(() => canonicalize({ "\ufb33": 3 })).toThrow("not NFC");
  });

  it("入れ子・配列・null・空白なし・-0", () => {
    expect(canonicalize({ b: [1, null, true, { d: "x", c: -0 }], a: "改行\n" })).toBe('{"a":"改行\\n","b":[1,null,true,{"c":0,"d":"x"}]}');
  });

  it("小数・NaN・安全でない整数・undefined・Date・関数は例外", () => {
    for (const v of [0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, { a: undefined }, [undefined], new Date(0), () => 1, 1n]) {
      expect(() => canonicalize(v)).toThrow();
    }
  });

  it("配列の穴・getter・Map・クラス・箱入りの数は例外、プロトタイプのないオブジェクトは受け付ける", () => {
    expect(() => canonicalize([1, , 2])).toThrow("hole");
    expect(() => canonicalize(new Array(2))).toThrow("hole");
    const arr = [0];
    Object.defineProperty(arr, 0, { get: () => 1, enumerable: true });
    expect(() => canonicalize(arr)).toThrow("accessor");
    expect(() => canonicalize({ get a() { return 1; } })).toThrow("accessor");
    for (const v of [new Map(), new (class X {})(), Object(1)]) expect(() => canonicalize(v)).toThrow("not a plain object");
    const bare = Object.assign(Object.create(null), { b: 1, a: 2 });
    expect(canonicalize(bare)).toBe('{"a":2,"b":1}');
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = [deep];
    expect(() => canonicalize(deep)).toThrow("nested deeper");
  });

  it("NFC でない文字列と、対になっていないサロゲートは例外（キーも）", () => {
    expect(() => canonicalize("\u30ab\u3099")).toThrow("not NFC"); // カ＋濁点（NFC ならガ）
    expect(canonicalize("\u30ac")).toBe('"ガ"');
    expect(() => canonicalize("\ud800")).toThrow("lone surrogate");
    expect(() => canonicalize({ "\udc00": 1 })).toThrow("lone surrogate");
  });

  it("文字 U+0000 は、値・キー・本文のどこにあっても例外（Postgres の text に保存できない。#110 PR-2d）", async () => {
    const nul = String.fromCharCode(0);
    expect(() => canonicalize(nul)).toThrow("NUL character at $");
    expect(() => canonicalize({ memo: `a${nul}b` })).toThrow("NUL character at $.memo");
    expect(() => canonicalize([["x", `${nul}`]])).toThrow("NUL character at $[0][1]");
    expect(() => canonicalize({ [`k${nul}`]: 1 })).toThrow("NUL character at $ key");
    await expect(bodyHash(new Uint8Array(16), `上がる${nul}`)).rejects.toThrow("NUL character at body");
    await expect(bodyHash(new Uint8Array(16), { value: { text: nul } })).rejects.toThrow("NUL character at $.text");
    // U+0000 でない制御文字（U+0001）や、「\u0000」という6文字の文字列は通す
    expect(canonicalize(String.fromCharCode(1))).toBe('"\\u0001"');
    expect(canonicalize("\\u0000")).toBe('"\\\\u0000"');
  });
});

describe("ハッシュ", () => {
  it("SHA-256 の既知の値", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("イベントのハッシュは、前置き＋正規化した JSON の SHA-256（形式が変われば分かるよう値を固定）", async () => {
    const e = await sealEvent(null, draft());
    expect(e.prevHash).toBe(GENESIS_HASH);
    // printf 'ffr-event-v1\n{"actor":"operator:owner","keys":[],"payload":{"agentId":"alpha"},"prevHash":"000…","recordedAt":1793580000000,"refs":[],"schema":1,"seq":1,"type":"agent.registered"}' | shasum -a 256
    expect(e.hash).toBe("d42e65c5fd1f5d8141c9326c130f1fbd1909d3f1e9abec821ef4440cb485b3b1");
  });

  it("口座のハッシュはイベントと前置きが違い、キーの順に依らない", async () => {
    const a = await accountHash({ cash: 100, holdings: { AAA: { qty: 100, cost: 50 } } });
    const b = await accountHash({ holdings: { AAA: { cost: 50, qty: 100 } }, cash: 100 });
    expect(a).toBe(b);
    expect(a).not.toBe(await sha256Hex(new TextEncoder().encode('ffr-event-v1\n{"cash":100,"holdings":{"AAA":{"cost":50,"qty":100}}}')));
  });

  it("本文のハッシュは乱数で変わり、乱数の長さと NFC を確かめる", async () => {
    const s1 = new Uint8Array(16);
    const s2 = new Uint8Array(16).fill(1);
    expect(await bodyHash(s1, "上がると思う")).not.toBe(await bodyHash(s2, "上がると思う"));
    expect(await bodyHash(s1, "上がると思う")).toBe(await bodyHash(new Uint8Array(16), "上がると思う"));
    await expect(bodyHash(new Uint8Array(15), "x")).rejects.toThrow("16 bytes");
    await expect(bodyHash("0123456789abcdef" as unknown as Uint8Array, "x")).rejects.toThrow("16 bytes");
    await expect(bodyHash(s1, "\u30ab\u3099")).rejects.toThrow("not NFC");
    expect(await bodyHash(s1, { value: { b: 1, a: 2 } })).toBe(await bodyHash(s1, { value: { a: 2, b: 1 } }));
  });
});

/** 検査を通さずに、ハッシュだけ正しく付け直したイベントを作る（壊れたログを再現するため） */
async function forge(fields: Record<string, unknown>): Promise<LogEvent> {
  const { hash: _, ...rest } = fields;
  return { ...rest, hash: await eventHash(rest as Omit<LogEvent, "hash">) } as LogEvent;
}

describe("連鎖の検査", () => {
  it("正しく作った連鎖と、空のログには問題がない", async () => {
    expect(await verifyChain(await chain(5))).toEqual([]);
    expect(await verifyChain([])).toEqual([]);
  });

  it("作ったイベントは凍結した写しで、あとから draft を変えてもずれない", async () => {
    const d = draft();
    const e = await sealEvent(null, d);
    (d.payload as { agentId: string }).agentId = "beta";
    expect(e.payload).toEqual({ agentId: "alpha" });
    expect(Object.isFrozen(e) && Object.isFrozen(e.payload)).toBe(true);
    expect(await verifyChain([e])).toEqual([]);
  });

  it("中身を書き換えると、そのイベントのハッシュが合わない", async () => {
    const c = await chain(3);
    c[1] = { ...c[1]!, payload: { agentId: "beta" } };
    expect(await verifyChain(c)).toEqual(["event #1 (seq 2 (number)): hash does not match the content"]);
  });

  it("書き換えてハッシュを付け直すと、次のイベントの prevHash が合わない", async () => {
    const c = await chain(3);
    c[1] = await forge({ ...c[1]!, payload: { agentId: "beta" } });
    expect(await verifyChain(c)).toEqual(["event #2 (seq 3 (number)): prevHash does not match the previous event"]);
  });

  it("イベントを抜くと、seq と prevHash が合わない", async () => {
    const c = await chain(3);
    expect(await verifyChain([c[0]!, c[2]!])).toEqual([
      "event #1 (seq 3 (number)): seq should be 2, got 3 (number)",
      "event #1 (seq 3 (number)): refs must point to earlier events", // 抜いた seq 2 を指している
      "event #1 (seq 3 (number)): prevHash does not match the previous event",
    ]);
  });

  it("項目の欠け・余分な項目は、ハッシュを付け直してあっても問題", async () => {
    const e = await sealEvent(null, draft());
    const { payload: _, ...noPayload } = e;
    expect(await verifyChain([await forge(noPayload)])).toEqual(["event #0 (seq 1 (number)): missing field payload"]);
    expect(await verifyChain([await forge({ ...e, extra: "x" })])).toEqual(["event #0 (seq 1 (number)): unknown field extra"]);
  });

  it("型の違う項目と、最初のイベントの prevHash の誤りは問題", async () => {
    const e = await sealEvent(null, draft());
    const bad = await forge({ ...e, seq: "1", schema: 2, recordedAt: -1, refs: "1", keys: "k", prevHash: "f".repeat(64) });
    expect(await verifyChain([bad])).toEqual([
      "event #0 (seq \"1\" (string)): seq should be 1, got \"1\" (string)",
      "event #0 (seq \"1\" (string)): unknown schema 2 (number)",
      "event #0 (seq \"1\" (string)): invalid recordedAt -1 (number)",
      "event #0 (seq \"1\" (string)): refs must point to earlier events",
      "event #0 (seq \"1\" (string)): keys must be an array",
      "event #0 (seq \"1\" (string)): prevHash does not match the previous event",
    ]);
    expect(await verifyChain([{ ...e, hash: "xyz" }])).toEqual(["event #0 (seq 1 (number)): invalid hash"]);
  });

  it("オブジェクトでないイベントや Symbol の項目でも、例外にせず報告する", async () => {
    const c = await chain(2);
    expect(await verifyChain([null, c[1]!])).toEqual(["event #0: not an object"]);
    const problems = await verifyChain([{ ...c[0]!, type: Symbol("x") }]);
    expect(problems).toContain("event #0 (seq 1 (number)): unknown type Symbol(x) (symbol)");
  });

  it("後のイベントや自分を指す参照、重複した参照は問題", async () => {
    const e1 = await sealEvent(null, draft());
    const e2 = await forge({ ...(await sealEvent(e1, draft({ keys: ["x"] }))), refs: [2] });
    const e3 = await forge({ ...(await sealEvent(e2, draft({ keys: ["y"] }))), refs: [1, 1] });
    expect(await verifyChain([e1, e2, e3])).toEqual([
      "event #1 (seq 2 (number)): refs must point to earlier events",
      "event #2 (seq 3 (number)): duplicate refs",
    ]);
  });

  it("一意キーの重複、時刻の逆行、知らない種類・書き手は問題", async () => {
    const e1 = await sealEvent(null, draft({ keys: ["sheet:alpha:2026-11-04"] }));
    const e2 = await forge({ ...(await sealEvent(e1, draft())), keys: ["sheet:alpha:2026-11-04"], recordedAt: e1.recordedAt - 1 });
    const e3 = await forge({ ...(await sealEvent(e2, draft({ recordedAt: e1.recordedAt + 1 }))), type: "bank.event", actor: "agent:", recordedAt: e1.recordedAt });
    expect(await verifyChain([e1, e2, e3])).toEqual([
      "event #1 (seq 2 (number)): recordedAt goes backwards",
      "event #1 (seq 2 (number)): duplicate key sheet:alpha:2026-11-04",
      "event #2 (seq 3 (number)): unknown type \"bank.event\" (string)",
      "event #2 (seq 3 (number)): invalid actor \"agent:\" (string)",
    ]);
  });

  it("形式の合わないイベントは作れない", async () => {
    const e1 = await sealEvent(null, draft({ keys: ["k"] }));
    await expect(sealEvent(e1, draft({ keys: ["k"] }), new Set(["k"]))).rejects.toThrow("duplicate key k");
    await expect(sealEvent(e1, draft({ keys: ["a", "a"] }))).rejects.toThrow("duplicate key a");
    await expect(sealEvent(e1, draft({ refs: [2] }))).rejects.toThrow("refs must point to earlier events");
    await expect(sealEvent(e1, draft({ recordedAt: e1.recordedAt - 1 }))).rejects.toThrow("recordedAt goes backwards");
    await expect(sealEvent(null, draft({ actor: "agent:" as EventDraft["actor"] }))).rejects.toThrow("invalid actor");
  });

  it("正規化できない中身のイベントは作れず、混ざっていれば問題として報告する", async () => {
    await expect(sealEvent(null, draft({ payload: { price: 1.5 } }))).rejects.toThrow("not a safe integer");
    const e1 = await sealEvent(null, draft());
    const bad = { ...e1, payload: { price: 1.5 } };
    expect(await verifyChain([bad])).toEqual(["event #0 (seq 1 (number)): cannot canonicalize: not a safe integer at $.payload.price: 1.5"]);
  });
});
