#!/usr/bin/env bash
# Called only after Windows verification; never move a tag or replace a public asset.
set -euo pipefail
: "${GH_REPO:?}" "${GITHUB_SHA:?}" "${TESTED_SHA256:?}" "${TAG:?}" "${ZIP:?}"
printf '%s  %s\n' "$TESTED_SHA256" "$ZIP" | sha256sum --check --strict
api="repos/$GH_REPO"

check_head() {
    local head
    head=$(gh api "$api/git/ref/heads/preview/native-717" --jq .object.sha)
    if [[ $head != "$GITHUB_SHA" ]]; then
        echo 'Superseded preview commit; not publishing.'
        exit 0
    fi
}

check_head
refs=$(gh api "$api/git/matching-refs/tags/$TAG")
tag_exists=$(jq --arg ref "refs/tags/$TAG" 'any(.[]; .ref == $ref)' <<< "$refs")
if [[ $tag_exists == true ]]; then
    test "$(gh api "$api/commits/$TAG" --jq .sha)" = "$GITHUB_SHA" || {
        echo 'The immutable preview tag points at another commit.' >&2; exit 1;
    }
fi

# Include drafts left by an interrupted publish. A transient API failure is not 'absent'.
release=$(gh api --paginate "$api/releases?per_page=100" --jq ".[] | select(.tag_name == \"$TAG\")" | jq -s 'if length > 1 then error("duplicate release") else first end')
notes="Portable Windows x64 Deck preview. Unzip and launch goymusic-native.exe. No installer or automatic updates.

Tested commit: $GITHUB_SHA
ZIP SHA-256: $TESTED_SHA256"
if [[ $release != null ]]; then
    jq -e '.prerelease' <<< "$release" >/dev/null
    if jq -e '.draft == false' <<< "$release" >/dev/null; then
        # A rebuild can have different ZIP timestamps. Leave the already-tested bytes intact.
        test "$tag_exists" = true
        jq -e --arg sha "$GITHUB_SHA" '.target_commitish == $sha' <<< "$release" >/dev/null
        jq -e --arg name "$ZIP" --arg sha "$GITHUB_SHA" '
            (.assets[0].digest | ltrimstr("sha256:")) as $hash |
            (.assets | length == 1) and .assets[0].name == $name and .assets[0].state == "uploaded" and
            (.assets[0].digest | test("^sha256:[0-9a-f]{64}$")) and
            (.body | contains("Tested commit: " + $sha)) and
            (.body | contains("ZIP SHA-256: " + $hash))
        ' <<< "$release" >/dev/null
        echo 'Verified preview already published; no changes.'
        exit 0
    fi
    jq -e --arg name "$ZIP" 'all(.assets[]; .name == $name)' <<< "$release" >/dev/null
    # A superseded or interrupted run may own this unpublished draft but not the tag.
    jq -e '.body | startswith("Portable Windows x64 Deck preview.")' <<< "$release" >/dev/null
    gh release edit "$TAG" --draft --prerelease --latest=false --target "$GITHUB_SHA" --notes "$notes"
else
    gh release create "$TAG" --draft --prerelease --latest=false --target "$GITHUB_SHA" \
        --title 'GoyMusic Deck 7.1.7-rust' --notes "$notes"
fi

gh release upload "$TAG" "$ZIP" --clobber
release_id=$(gh release view "$TAG" --json databaseId --jq .databaseId)
assets=$(gh api "$api/releases/$release_id/assets")
jq -e --arg name "$ZIP" --arg digest "sha256:$TESTED_SHA256" \
    'length == 1 and .[0].name == $name and .[0].digest == $digest and .[0].state == "uploaded"' <<< "$assets" >/dev/null
check_head
if [[ $tag_exists == false ]]; then
    gh api --method POST "$api/git/refs" -f ref="refs/tags/$TAG" -f sha="$GITHUB_SHA" >/dev/null
fi
test "$(gh api "$api/commits/$TAG" --jq .sha)" = "$GITHUB_SHA"
gh release edit "$TAG" --verify-tag --target "$GITHUB_SHA" --draft=false --prerelease --latest=false --notes "$notes"
