#!/usr/bin/env bash
set -euo pipefail

: "${API_BASE:?Set API_BASE, for example https://PROJECT.supabase.co/functions/v1}"
: "${SUPABASE_ANON_KEY:?Set SUPABASE_ANON_KEY}"
: "${ACCESS_TOKEN:?Set ACCESS_TOKEN to a Supabase JWT for a signed-in user}"

auth_headers=(-H "Authorization: Bearer ${ACCESS_TOKEN}" -H "apikey: ${SUPABASE_ANON_KEY}" -H "Content-Type: application/json")

project_json=$(curl -fsS "${auth_headers[@]}" -X POST "${API_BASE}/v1-projects" \
  -d '{"name":"Smoke Test","description":"Created by scripts/smoke.sh"}')
project_id=$(jq -r '.project.id' <<<"${project_json}")
echo "Created project ${project_id}"

source_payload=$(jq -nc --arg project_id "${project_id}" \
  '{project_id:$project_id,title:"Facts",text:"ReplyMate smoke-test fact: the launch color is cobalt blue."}')
source_json=$(curl -fsS "${auth_headers[@]}" -X POST "${API_BASE}/v1-context" -d "${source_payload}")
source_id=$(jq -r '.source.id' <<<"${source_json}")
echo "Created source ${source_id}"

curl -fsS "${auth_headers[@]}" "${API_BASE}/v1-context?project_id=${project_id}" | jq .

chat_payload=$(jq -nc --arg project_id "${project_id}" \
  '{project_id:$project_id,message:"What is the launch color?"}')
curl -fsS "${auth_headers[@]}" -X POST "${API_BASE}/v1-chat" -d "${chat_payload}" | jq .

curl -fsS "${auth_headers[@]}" -X DELETE "${API_BASE}/v1-context?source_id=${source_id}" | jq .
echo "Smoke test complete. Project ${project_id} was retained for inspection."
