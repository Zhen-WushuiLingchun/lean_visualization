import Toy.Lemmas

/-!
# Main

The final theorem touches every taint at once.
-/

namespace Toy

/-- The final theorem. Its statement mentions the `partial`, `@[implemented_by]` and `@[extern]`
definitions, and its proof uses `sorry`, the custom axiom and `native_decide`, so its trust
profile carries every taint. -/
theorem everything :
    collatz 6 = collatz 6 ∧ fastEq 1 1 = fastEq 1 1 ∧ cMix 1 2 = cMix 1 2 ∧
      3 ≤ 3 * 3 ∧ 5 * 1 = 5 ∧ 2 ^ 20 = 1048576 :=
  ⟨rfl, rfl, rfl, usesOracle, usesUnfinished, bigPower⟩

end Toy
