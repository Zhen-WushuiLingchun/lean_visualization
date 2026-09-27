import Mathlib.NumberTheory.PrimeCounting
import Mathlib.Analysis.SpecialFunctions.Pow.Real
import Mathlib.Data.Real.Sqrt
import Mathlib.NumberTheory.Real.Irrational

/-! A few Mathlib-backed results used to exercise ProofFlow at Mathlib scale. -/

namespace MathlibDemo

/-- There are infinitely many primes (Mathlib's statement, re-exported). -/
theorem infinitely_many_primes : ∀ n : ℕ, ∃ p, n ≤ p ∧ p.Prime :=
  Nat.exists_infinite_primes

/-- The square root of 2 is irrational. -/
theorem sqrt_two_irrational : Irrational (Real.sqrt 2) :=
  irrational_sqrt_two

/-- A small real-analysis fact: `2 ^ (1/2 : ℝ)` squared is `2`. -/
theorem rpow_half_sq : ((2 : ℝ) ^ ((1 : ℝ) / 2)) ^ (2 : ℕ) = 2 := by
  rw [← Real.rpow_natCast, ← Real.rpow_mul (by norm_num : (0:ℝ) ≤ 2)]
  norm_num

/-- An unfinished lemma, to show sorry propagation through Mathlib-backed proofs. -/
theorem unfinished_bound (n : ℕ) : Nat.primeCounting n ≤ n := by
  sorry

/-- Uses the unfinished lemma. -/
theorem uses_unfinished : Nat.primeCounting 10 ≤ 10 := unfinished_bound 10

/-- Combines everything. -/
theorem summary : Irrational (Real.sqrt 2) ∧ (∀ n : ℕ, ∃ p, n ≤ p ∧ p.Prime) :=
  ⟨sqrt_two_irrational, infinitely_many_primes⟩

end MathlibDemo
