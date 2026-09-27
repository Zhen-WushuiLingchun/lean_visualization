import Toy.Axioms
import Toy.Defs
import Toy.Lemmas
import Toy.Main

/-!
# Toy

A small Lean project that exercises every trust case ProofFlow reports. It is the golden
fixture for the extractor (`examples/toy/expected/graph.json`).

`Check.lean` (next to this file, not part of the library) runs `#print axioms` on every
interesting declaration so the extracted trust profile can be cross-checked by hand.
-/
