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

  it("NFC でない文字列と、対になっていないサロゲートは例外（キーも）", () => {
    expect(() => canonicalize("\u30ab\u3099")).toThrow("not NFC"); // カ＋濁点（NFC ならガ）
    expect(canonicalize("\u30ac")).toBe('"ガ"');
    expect(() => canonicalize("\ud800")).toThrow("lone surrogate");
    expect(() => canonicalize({ "\udc00": 1 })).toThrow("lone surrogate");
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
    await expect(bodyHash(s1, "\u30ab\u3099")).rejects.toThrow("not NFC");
    expect(await bodyHash(s1, { value: { b: 1, a: 2 } })).toBe(await bodyHash(s1, { value: { a: 2, b: 1 } }));
  });
});

describe("連鎖の検査", () => {
  it("正しく作った連鎖には問題がない", async () => {
    expect(await verifyChain(await chain(5))).toEqual([]);
  });

  it("中身を書き換えると、そのイベントのハッシュが合わない", async () => {
    const c = await chain(3);
    c[1] = { ...c[1]!, payload: { agentId: "beta" } };
    expect(await verifyChain(c)).toEqual(["event #1 (seq 2): hash does not match the content"]);
  });

  it("書き換えてハッシュを付け直すと、次のイベントの prevHash が合わない", async () => {
    const c = await chain(3);
    const { hash: _, ...rest } = { ...c[1]!, payload: { agentId: "beta" } };
    c[1] = { ...rest, hash: await eventHash(rest) };
    expect(await verifyChain(c)).toEqual(["event #2 (seq 3): prevHash does not match the previous event"]);
  });

  it("イベントを抜くと、seq と prevHash が合わない", async () => {
    const c = await chain(3);
    const problems = await verifyChain([c[0]!, c[2]!]);
    expect(problems).toContain("event #1 (seq 3): seq should be 2");
    expect(problems).toContain("event #1 (seq 3): prevHash does not match the previous event");
  });

  it("後のイベントを指す参照、自分を指す参照は問題", async () => {
    const e1 = await sealEvent(null, draft({ refs: [1] }));
    expect(await verifyChain([e1])).toEqual(["event #0 (seq 1): refs must point to earlier events"]);
  });

  it("一意キーの重複、時刻の逆行、知らない種類・書き手は問題", async () => {
    const e1 = await sealEvent(null, draft({ keys: ["sheet:alpha:2026-11-04"] }));
    const e2 = await sealEvent(e1, draft({ keys: ["sheet:alpha:2026-11-04"], recordedAt: e1.recordedAt - 1 }));
    const e3 = await sealEvent(e2, draft({ type: "bank.event" as EventDraft["type"], actor: "agent:" as EventDraft["actor"], recordedAt: e1.recordedAt }));
    expect(await verifyChain([e1, e2, e3])).toEqual([
      "event #1 (seq 2): recordedAt goes backwards",
      "event #1 (seq 2): duplicate key sheet:alpha:2026-11-04",
      "event #2 (seq 3): unknown type bank.event",
      "event #2 (seq 3): invalid actor",
    ]);
  });

  it("正規化できない中身のイベントは作れず、混ざっていれば問題として報告する", async () => {
    await expect(sealEvent(null, draft({ payload: { price: 1.5 } }))).rejects.toThrow("not a safe integer");
    const e1 = await sealEvent(null, draft());
    const bad = { ...e1, payload: { price: 1.5 } };
    expect(await verifyChain([bad])).toEqual(["event #0 (seq 1): cannot canonicalize: not a safe integer at $.payload.price: 1.5"]);
  });
});
