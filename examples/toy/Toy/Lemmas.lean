import Toy.Defs

/-!
# Lemmas

A clean chain, an unfinished proof, a `native_decide` proof, and lemmas that reach the
custom axiom through an inductive type.
-/

namespace Toy

/-- Step 1 of the clean chain. -/
theorem lemma1 (n : Nat) : n + 0 = n := rfl

/-- Step 2 of the clean chain. -/
theorem lemma2 (n : Nat) : 0 + (n + 0) = n := by
  rw [lemma1]
  exact Nat.zero_add n

/-- The clean final result: rests on no axiom beyond the standard ones. -/
theorem cleanMain : ∀ n : Nat, 0 + (n + 0) = n := fun n => lemma2 n

/-- An unfinished proof. -/
theorem unfinished (n : Nat) : n * 1 = n := by
  sorry

/-- A lemma whose proof uses the unfinished one. -/
theorem usesUnfinished : 5 * 1 = 5 := unfinished 5

/-- Proved by compiling and running code (`native_decide`). -/
theorem bigPower : 2 ^ 20 = 1048576 := by
  native_decide

/-- About the noncomputable `pick`: rests on `Classical.choice` only. -/
theorem pick_self (α : Type) [Nonempty α] : pick α = pick α := rfl

/-- Uses the equation lemmas of the structurally recursive `sumTo`. -/
theorem sumTo_succ (n : Nat) : sumTo (n + 1) = (n + 1) + sumTo n := by
  simp [sumTo]

/-- Uses the equation lemmas of the pattern-matching `Color.next`. -/
theorem next_red : Color.next .red = .green := by
  simp [Color.next]

/-- Builds a certificate: reaches the custom axiom through the constructor. -/
theorem certified_five : Certified 5 := .mk 5 rfl

/-- Only the statement mentions `Certified`; the custom axiom is still reachable through the
inductive's constructor. -/
theorem certified_trivial (_h : Certified 5) : True := trivial

/-- Like `certified_trivial`, over `Signed`. `#print axioms` inherits the under-reported entry of
`Toy.Signed` (lean4#15226) and reports no axioms here; the extractor reports `Toy.oracle`. -/
theorem signed_trivial (_h : Signed 5) : True := trivial

/-- Uses the oracle-backed structure `Bounded`. -/
def boundedFive : Bounded := ⟨5, (squareBound 5).property⟩

end Toy
