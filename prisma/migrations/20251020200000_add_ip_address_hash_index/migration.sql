-- CreateIndex
-- Add index on ipAddressHash for optimized metrics queries
CREATE INDEX IF NOT EXISTS "User_ipAddressHash_idx" ON "User"("ipAddressHash");
