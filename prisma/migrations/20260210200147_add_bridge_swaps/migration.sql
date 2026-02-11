-- CreateEnum
CREATE TYPE "SwapType" AS ENUM ('submarine', 'reverse', 'chain');

-- CreateTable
CREATE TABLE "bridge_swaps" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "SwapType" NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "asset_send" TEXT NOT NULL,
    "asset_receive" TEXT NOT NULL,
    "send_amount" BIGINT NOT NULL,
    "receive_amount" BIGINT NOT NULL,
    "date" BIGINT NOT NULL,
    "preimage" TEXT NOT NULL,
    "preimage_hash" TEXT NOT NULL,
    "preimage_seed" TEXT NOT NULL,
    "key_index" INTEGER NOT NULL,
    "claim_private_key_index" INTEGER,
    "refund_private_key_index" INTEGER,
    "claim_address" TEXT NOT NULL,
    "address" TEXT,
    "refund_address" TEXT,
    "lockup_address" TEXT,
    "claim_tx" TEXT,
    "refund_tx" TEXT,
    "lockup_tx" TEXT,
    "invoice" TEXT,
    "accept_zero_conf" BOOLEAN,
    "expected_amount" BIGINT,
    "onchain_amount" BIGINT,
    "timeout_block_height" INTEGER,
    "claim_details" JSONB,
    "lockup_details" JSONB,
    "referral_id" TEXT,
    "chain_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bridge_swaps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bridge_swaps_user_id_idx" ON "bridge_swaps"("user_id");

-- CreateIndex
CREATE INDEX "bridge_swaps_user_id_status_idx" ON "bridge_swaps"("user_id", "status");

-- CreateIndex
CREATE INDEX "bridge_swaps_user_id_date_idx" ON "bridge_swaps"("user_id", "date" DESC);

-- CreateIndex
CREATE INDEX "bridge_swaps_status_idx" ON "bridge_swaps"("status");

-- CreateIndex
CREATE INDEX "bridge_swaps_type_idx" ON "bridge_swaps"("type");

-- CreateIndex
CREATE INDEX "bridge_swaps_preimage_hash_idx" ON "bridge_swaps"("preimage_hash");

-- CreateIndex
CREATE INDEX "bridge_swaps_date_idx" ON "bridge_swaps"("date" DESC);
