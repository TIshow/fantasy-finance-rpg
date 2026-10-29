-- CreateTable
CREATE TABLE "matches" (
    "id" UUID NOT NULL,
    "join_code" TEXT NOT NULL,
    "scenario_id" TEXT NOT NULL,
    "scenario_hash" TEXT NOT NULL,
    "sheet_hash" TEXT NOT NULL,
    "algorithm_version" TEXT NOT NULL,
    "k_scale" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'auto',
    "round" INTEGER NOT NULL DEFAULT 0,
    "total_rounds" INTEGER NOT NULL,
    "phase_ends_at" TIMESTAMPTZ(3),
    "paused_from" TEXT,
    "paused_remaining_ms" INTEGER,
    "reveal_at" TIMESTAMPTZ(3),
    "timing" JSONB NOT NULL,
    "q" JSONB NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 12,
    "version" INTEGER NOT NULL DEFAULT 1,
    "host_token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(3),

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "nickname" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "team_id" UUID,
    "cash" INTEGER NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "account_id" UUID NOT NULL,
    "guild_id" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "cost_basis" INTEGER NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("account_id","guild_id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "account_id" UUID NOT NULL,
    "guild_id" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "reserve_cash" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "round_clearings" (
    "match_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "algorithm_version" TEXT NOT NULL,
    "prices_before" JSONB NOT NULL,
    "prices" JSONB NOT NULL,
    "q_after" JSONB NOT NULL,
    "stats" JSONB NOT NULL,
    "forecasts" JSONB NOT NULL,
    "input_hash" TEXT NOT NULL,
    "output_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "round_clearings_pkey" PRIMARY KEY ("match_id","round")
);

-- CreateTable
CREATE TABLE "fills" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "account_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "guild_id" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "requested" INTEGER NOT NULL,
    "filled" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,
    "cash_delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "fills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investigations" (
    "match_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "investigations_pkey" PRIMARY KEY ("match_id","team_id")
);

-- CreateTable
CREATE TABLE "match_events" (
    "id" BIGSERIAL NOT NULL,
    "match_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "public_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "matches_join_code_key" ON "matches"("join_code");

-- CreateIndex
CREATE UNIQUE INDEX "teams_token_hash_key" ON "teams"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "teams_match_id_nickname_key" ON "teams"("match_id", "nickname");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_team_id_key" ON "accounts"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_match_id_key_key" ON "accounts"("match_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "orders_match_id_round_account_id_guild_id_key" ON "orders"("match_id", "round", "account_id", "guild_id");

-- CreateIndex
CREATE INDEX "fills_match_id_round_idx" ON "fills"("match_id", "round");

-- CreateIndex
CREATE INDEX "fills_match_id_account_key_idx" ON "fills"("match_id", "account_key");

-- CreateIndex
CREATE INDEX "match_events_match_id_id_idx" ON "match_events"("match_id", "id");

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_clearings" ADD CONSTRAINT "round_clearings_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fills" ADD CONSTRAINT "fills_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 手で追加：不変条件（市場係を除き、現金と保有は負にならない）
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_cash_nonnegative" CHECK ("kind" = 'mm' OR "cash" >= 0);
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_kind_valid" CHECK ("kind" IN ('player', 'npc', 'mm'));
ALTER TABLE "positions" ADD CONSTRAINT "positions_cost_basis_nonnegative" CHECK ("cost_basis" >= 0 OR "qty" < 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_side_valid" CHECK ("side" IN ('buy', 'sell'));
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_valid" CHECK ("status" IN ('active', 'cancelled'));
ALTER TABLE "orders" ADD CONSTRAINT "orders_qty_positive" CHECK ("qty" >= 1);
ALTER TABLE "orders" ADD CONSTRAINT "orders_reserve_nonnegative" CHECK ("reserve_cash" >= 0);
ALTER TABLE "matches" ADD CONSTRAINT "matches_phase_valid" CHECK ("phase" IN ('LOBBY', 'NEWS', 'ORDER_OPEN', 'PUBLISHED', 'PAUSED', 'RESULT', 'ABORTED'));

-- 保有の非負は、市場係の口座を除いて確かめる（市場係は売り持ち）
CREATE FUNCTION "positions_nonnegative_check"() RETURNS trigger AS $$
BEGIN
  IF NEW."qty" < 0 AND (SELECT "kind" FROM "accounts" WHERE "id" = NEW."account_id") <> 'mm' THEN
    RAISE EXCEPTION 'negative holdings for account %', NEW."account_id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "positions_nonnegative" BEFORE INSERT OR UPDATE ON "positions"
  FOR EACH ROW EXECUTE FUNCTION "positions_nonnegative_check"();

-- SupabaseのData APIはpublicスキーマを外部に出すため、RLSを有効にしてポリシーは置かない（全拒否）。
-- アプリはテーブルの所有者として接続するので影響を受けない（ARCHITECTURE §10）。
ALTER TABLE "matches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "positions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "round_clearings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fills" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "investigations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "match_events" ENABLE ROW LEVEL SECURITY;
