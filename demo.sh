#!/usr/bin/env bash
# ShelfSmith end-to-end demo: scan -> enrich (live AI) -> verify persistence -> digest.
# Resolves all resource names from the deployed CloudFormation stack, so nothing
# is hardcoded. Pauses between steps when run interactively; runs straight
# through when piped/non-interactive.
set -euo pipefail

STACK="ShelfSmithStack"
REGION="${AWS_REGION:-us-east-1}"
TITLE="${1:-NovaSound Z9 Soundbar}"
SPECS="${2:-120W, Dolby Atmos, HDMI eARC, wireless subwoofer, Bluetooth 5.2}"

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
pause() { if [ -t 0 ]; then read -rp $'\nPress Enter to continue...\n'; fi; }
out() { aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

bold "Resolving stack outputs ($STACK / $REGION)..."
ENRICH_URL="$(out EnrichEndpoint)"
TABLE="$(out TableName)"
DIGEST_FN="$(out DigestFunctionName)"
echo "  endpoint : $ENRICH_URL"
echo "  table    : $TABLE"
echo "  digestFn : $DIGEST_FN"
pause

bold "1) Current catalog in DynamoDB"
aws dynamodb scan --table-name "$TABLE" --region "$REGION" \
  --query 'Items[].{id:productId.S, sk:sk.S, category:category.S}' --output table
pause

bold "2) Enrich a NEW product via Bedrock (live AI call)"
echo "   title: $TITLE"
echo "   specs: $SPECS"
RESP="$(curl -s -X POST "$ENRICH_URL" -H 'content-type: application/json' \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"title":sys.argv[1],"specs":sys.argv[2]}))' "$TITLE" "$SPECS")")"
echo "$RESP" | python3 -m json.tool
PID="$(echo "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["productId"])')"
pause

bold "3) Read it straight back from DynamoDB (proves it persisted)"
aws dynamodb get-item --table-name "$TABLE" --region "$REGION" \
  --key "{\"productId\":{\"S\":\"$PID\"},\"sk\":{\"S\":\"PRODUCT\"}}" \
  --query 'Item.{title:title.S, category:category.S, createdAt:createdAt.S}' --output table
pause

bold "4) Run the scheduled review-digest on demand"
aws lambda invoke --function-name "$DIGEST_FN" --region "$REGION" \
  --cli-binary-format raw-in-base64-out --payload '{}' /tmp/shelfsmith-digest.json >/dev/null
python3 -m json.tool /tmp/shelfsmith-digest.json

bold "Demo complete."
