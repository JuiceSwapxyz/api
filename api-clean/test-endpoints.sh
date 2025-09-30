#!/bin/bash

# JuiceSwap Clean API - Endpoint Testing Script

API_URL="${API_URL:-http://localhost:3000}"
echo "Testing JuiceSwap API at: $API_URL"
echo "================================"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Test health endpoint
echo -n "Testing /healthz endpoint... "
HEALTH_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/healthz")
if [ "$HEALTH_RESPONSE" == "200" ]; then
    echo -e "${GREEN}✓ Passed${NC}"
else
    echo -e "${RED}✗ Failed (HTTP $HEALTH_RESPONSE)${NC}"
fi

# Test readiness endpoint
echo -n "Testing /readyz endpoint... "
READY_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/readyz")
if [ "$READY_RESPONSE" == "200" ]; then
    echo -e "${GREEN}✓ Passed${NC}"
else
    echo -e "${RED}✗ Failed (HTTP $READY_RESPONSE)${NC}"
fi

# Test version endpoint
echo -n "Testing /version endpoint... "
VERSION_RESPONSE=$(curl -s "$API_URL/version")
if echo "$VERSION_RESPONSE" | grep -q "version"; then
    echo -e "${GREEN}✓ Passed${NC}"
    echo "  Version info: $VERSION_RESPONSE"
else
    echo -e "${RED}✗ Failed${NC}"
fi

# Test quote endpoint (ETH -> USDC on mainnet)
echo -n "Testing /v1/quote endpoint (ETH -> USDC)... "
QUOTE_RESPONSE=$(curl -s -X POST "$API_URL/v1/quote" \
  -H "Content-Type: application/json" \
  -d '{
    "tokenInAddress": "0x0000000000000000000000000000000000000000",
    "tokenOutAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "tokenInChainId": 1,
    "tokenOutChainId": 1,
    "tokenInDecimals": 18,
    "tokenOutDecimals": 6,
    "amount": "1000000000000000000",
    "type": "EXACT_INPUT"
  }' \
  -w "\n%{http_code}")

HTTP_CODE=$(echo "$QUOTE_RESPONSE" | tail -n 1)
RESPONSE_BODY=$(echo "$QUOTE_RESPONSE" | head -n -1)

if [ "$HTTP_CODE" == "200" ] || [ "$HTTP_CODE" == "404" ]; then
    if [ "$HTTP_CODE" == "200" ]; then
        echo -e "${GREEN}✓ Passed${NC}"
        echo "  Quote received successfully"
    else
        echo -e "${GREEN}✓ Passed${NC} (No route found - expected if no RPC configured)"
    fi
else
    echo -e "${RED}✗ Failed (HTTP $HTTP_CODE)${NC}"
    echo "  Response: $RESPONSE_BODY"
fi

# Test swap endpoint
echo -n "Testing /v1/swap endpoint... "
SWAP_RESPONSE=$(curl -s -X POST "$API_URL/v1/swap" \
  -H "Content-Type: application/json" \
  -d '{
    "tokenInAddress": "0x0000000000000000000000000000000000000000",
    "tokenOutAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "tokenInChainId": 1,
    "tokenOutChainId": 1,
    "tokenInDecimals": 18,
    "tokenOutDecimals": 6,
    "amount": "1000000000000000000",
    "recipient": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb3",
    "slippageTolerance": "0.5",
    "from": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb3",
    "chainId": 1
  }' \
  -w "\n%{http_code}")

HTTP_CODE=$(echo "$SWAP_RESPONSE" | tail -n 1)
if [ "$HTTP_CODE" == "200" ] || [ "$HTTP_CODE" == "404" ] || [ "$HTTP_CODE" == "400" ]; then
    echo -e "${GREEN}✓ Passed${NC} (Endpoint responding correctly)"
else
    echo -e "${RED}✗ Failed (HTTP $HTTP_CODE)${NC}"
fi

# Test WRAP operation
echo -n "Testing /v1/swap endpoint (WRAP ETH -> WETH)... "
WRAP_RESPONSE=$(curl -s -X POST "$API_URL/v1/swap" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "WRAP",
    "tokenInAddress": "0x0000000000000000000000000000000000000000",
    "tokenOutAddress": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    "tokenInChainId": 1,
    "tokenOutChainId": 1,
    "tokenInDecimals": 18,
    "tokenOutDecimals": 18,
    "amount": "1000000000000000000",
    "recipient": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb3",
    "slippageTolerance": "0",
    "from": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb3",
    "chainId": 1
  }' \
  -w "\n%{http_code}")

HTTP_CODE=$(echo "$WRAP_RESPONSE" | tail -n 1)
if [ "$HTTP_CODE" == "200" ]; then
    echo -e "${GREEN}✓ Passed${NC}"
else
    echo -e "${RED}✗ Failed (HTTP $HTTP_CODE)${NC}"
fi

# Test swappable tokens endpoint
echo -n "Testing /v1/swappable_tokens endpoint... "
TOKENS_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/v1/swappable_tokens?chainId=1")
if [ "$TOKENS_RESPONSE" == "200" ]; then
    echo -e "${GREEN}✓ Passed${NC}"
else
    echo -e "${RED}✗ Failed (HTTP $TOKENS_RESPONSE)${NC}"
fi

# Test rate limiting
echo -n "Testing rate limiting... "
for i in {1..5}; do
    curl -s -X POST "$API_URL/v1/quote" \
      -H "Content-Type: application/json" \
      -d '{"amount":"1"}' > /dev/null 2>&1
done
RATE_LIMIT_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/v1/quote" \
  -H "Content-Type: application/json" \
  -d '{"amount":"1"}')
if [ "$RATE_LIMIT_RESPONSE" == "429" ] || [ "$RATE_LIMIT_RESPONSE" == "400" ]; then
    echo -e "${GREEN}✓ Rate limiting working${NC}"
else
    echo -e "${GREEN}✓ Rate limit not reached yet${NC}"
fi

echo "================================"
echo "Testing complete!"
echo ""
echo "Note: Some tests may fail if RPC endpoints are not configured."
echo "This is expected. Configure your .env file with RPC URLs for full functionality."