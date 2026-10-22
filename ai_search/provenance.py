"""Conservative text-overlap heuristic, not proof of authorship or independence."""
import hashlib
import re
import unicodedata
from itertools import combinations

from .models import Source, SourceGroup, SourceMatch

MIN_TOKENS = 80
MIN_SHARED_SHINGLES = 60
JACCARD_THRESHOLD = 0.80
CONTAINMENT_THRESHOLD = 0.90
MIN_LENGTH_RATIO = 0.65


def tokenize(content: str) -> list[str]:
    # Chinese characters and English words; retain numbers to avoid hiding edits.
    text = unicodedata.normalize("NFKC", content).casefold()
    return re.findall(r"[\u3400-\u9fff]|[a-z0-9]+", text)


def shingles(tokens: list[str]) -> set[tuple[str, ...]]:
    return {tuple(tokens[i:i + 5]) for i in range(len(tokens) - 4)}


def group_sources(sources: list[Source]) -> list[SourceGroup]:
    tokens = {s.id: tokenize(s.content) for s in sources}
    grams = {sid: shingles(words) for sid, words in tokens.items()}
    eligible = {
        s.id for s in sources
        if s.content_type == "page_extract" and len(tokens[s.id]) >= MIN_TOKENS
    }
    matches = {}
    for source in sources:
        source.content_fingerprint = hashlib.sha256(
            " ".join(tokens[source.id]).encode("utf-8")
        ).hexdigest()
    for left, right in combinations(sources, 2):
        if left.id not in eligible or right.id not in eligible:
            continue
        a, b = grams[left.id], grams[right.id]
        shared = len(a & b)
        if shared < MIN_SHARED_SHINGLES:
            continue
        jaccard = shared / len(a | b)
        containment = shared / min(len(a), len(b))
        ratio = min(len(tokens[left.id]), len(tokens[right.id])) / max(len(tokens[left.id]), len(tokens[right.id]))
        if ratio >= MIN_LENGTH_RATIO and (jaccard >= JACCARD_THRESHOLD or containment >= CONTAINMENT_THRESHOLD):
            matches[frozenset((left.id, right.id))] = SourceMatch(
                source_ids=[left.id, right.id], jaccard=round(jaccard, 4),
                containment=round(containment, 4), length_ratio=round(ratio, 4),
            )
    clusters: list[list[str]] = []
    for source in sources:
        # Require a match to every member: A~B and B~C alone must not merge A~C.
        for cluster in clusters:
            if all(frozenset((source.id, member)) in matches for member in cluster):
                cluster.append(source.id)
                break
        else:
            clusters.append([source.id])
    groups = []
    source_map = {s.id: s for s in sources}
    for index, cluster in enumerate(clusters, 1):
        group_id = f"G{index}"
        for sid in cluster:
            source_map[sid].evidence_group_id = group_id
        groups.append(SourceGroup(
            id=group_id, source_ids=cluster,
            status="possible_shared_content" if len(cluster) > 1 else "undetermined",
            matches=[matches[frozenset(pair)] for pair in combinations(cluster, 2)],
        ))
    return groups
