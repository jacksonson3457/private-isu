#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

docker compose -f "$script_dir/compose.yml" logs --no-log-prefix app |
  grep -F '"type":"get-index-timing"' |
  jq -s '
    if length == 0 then
      error("get-index-timing logs not found")
    else
      {
        count: length,
        sessionUser: {
          avg: (map(.sessionUserMs) | add / length),
          p50: (map(.sessionUserMs) | sort | .[(length * 0.50 | floor)]),
          p95: (map(.sessionUserMs) | sort | .[(length * 0.95 | floor)]),
          max: (map(.sessionUserMs) | max)
        },
        postsSelect: {
          avg: (map(.postsSelectMs) | add / length),
          p50: (map(.postsSelectMs) | sort | .[(length * 0.50 | floor)]),
          p95: (map(.postsSelectMs) | sort | .[(length * 0.95 | floor)]),
          max: (map(.postsSelectMs) | max)
        },
        makePosts: {
          avg: (map(.makePostsMs) | add / length),
          p50: (map(.makePostsMs) | sort | .[(length * 0.50 | floor)]),
          p95: (map(.makePostsMs) | sort | .[(length * 0.95 | floor)]),
          max: (map(.makePostsMs) | max)
        },
        render: {
          avg: (map(.renderMs) | add / length),
          p50: (map(.renderMs) | sort | .[(length * 0.50 | floor)]),
          p95: (map(.renderMs) | sort | .[(length * 0.95 | floor)]),
          max: (map(.renderMs) | max)
        },
        total: {
          avg: (map(.totalMs) | add / length),
          p50: (map(.totalMs) | sort | .[(length * 0.50 | floor)]),
          p95: (map(.totalMs) | sort | .[(length * 0.95 | floor)]),
          max: (map(.totalMs) | max)
        }
      }
    end
  '
