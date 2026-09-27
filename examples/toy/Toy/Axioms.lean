/-!
# Custom axioms

The project asserts one proposition without proof. Everything that rests on it must be
reported with the `customAxiom` taint.
-/

namespace Toy

/-- Every natural number is at most its square. True, but this project simply assumes it. -/
axiom oracle : ∀ n : Nat, n ≤ n * n

/-- A theorem that uses the custom axiom directly. -/
theorem usesOracle : 3 ≤ 3 * 3 := oracle 3

/-- A definition whose value uses the custom axiom inside a proof term. -/
def squareBound (n : Nat) : { m : Nat // n ≤ m } := ⟨n * n, oracle n⟩

/-- A proposition whose only constructor mentions the custom axiom in its type.
Regression for lean4#15226: the inductive itself must report `Toy.oracle`. -/
inductive Certified : Nat → Prop
  | mk (n : Nat) (h : oracle n = oracle n) : Certified n

/-- Same shape as `Certified`, different name. Regression for lean4#15226 that actually triggers
on v4.35.0-rc3: `#print axioms Toy.Signed` in a downstream module reports no axioms, although
`#print axioms Toy.Signed.mk` reports `Toy.oracle`. The per-module axiom table written into the
`.olean` is filled with a shared cache, and this module happens to visit the constructor before
the inductive, so the inductive is cached while it is still in progress. Whether a given
inductive is affected depends only on the hashes of its name and its constructor's name. The
extractor does not read that table and reports `Toy.oracle` for both. -/
inductive Signed : Nat → Prop
  | mk (n : Nat) (h : oracle n = oracle n) : Signed n

/-- A structure whose field type mentions `squareBound`, a definition that uses the axiom. -/
structure Bounded where
  /-- The number. -/
  n : Nat
  /-- The oracle-backed bound. -/
  bound : n ≤ (squareBound n).val

end Toy
