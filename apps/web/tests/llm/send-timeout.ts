// 送る時間の上限（10分）の試験の道具：中断されるまで返らない偽の fetch と、偽の時計で時間を進める手順。
// 送る処理の待ち時間が10分より短く、上限を超えて裏で送り続けないことを、各社の口の試験で確かめる。
import { vi } from "vitest";

/** respond が Response を返す URL はすぐ返し、ほかは AbortSignal で中断されるまで返らない fetch */
export function hangingFetch(respond: (url: string) => Response | undefined = () => undefined) {
  const state = { calls: 0, aborted: 0 };
  const f = ((input: RequestInfo | URL, init?: RequestInit) => {
    state.calls += 1;
    const r = respond(String(input));
    if (r !== undefined) return Promise.resolve(r);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        state.aborted += 1;
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }) as typeof fetch;
  return { f, state };
}

/** run を偽の時計（setTimeout だけ）で走らせ、1秒ずつ進めて、終わった時刻（ミリ秒）を返す。limitMs までに終わらなければ null */
export async function settledAt(run: () => Promise<unknown>, limitMs: number): Promise<number | null> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let done = false;
    void run().finally(() => {
      done = true;
    });
    for (let t = 0; t < limitMs; t += 1000) {
      // ハッシュの計算など、時計に関係しない待ちを先に進める
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
      if (done) return t;
      await vi.advanceTimersByTimeAsync(1000);
    }
    return null;
  } finally {
    vi.useRealTimers();
  }
}
