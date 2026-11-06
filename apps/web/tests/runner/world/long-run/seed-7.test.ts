// 長い通しの試験（#139）の、SEEDS[7] の種の分。中身は run.ts（種ごとに別のファイルにして、並べて回せるようにする）
import { describe } from "vitest";
import { SEEDS, longRun } from "./run";

describe(`架空の市場を60営業日回す（種 ${SEEDS[7]}）`, () => longRun(7));
