import Toy.Axioms

/-!
# Definitions

Ordinary data, plus every kind of definition the kernel cannot fully see:
`noncomputable`, `unsafe`, `@[implemented_by]`, `partial`, `@[extern]` and `opaque`.
-/

namespace Toy

/-- Three colours. An ordinary inductive type with auto-generated companions. -/
inductive Color where
  | red
  | green
  | blue

/-- Rotate a colour. Defined by pattern matching, so Lean creates `Toy.Color.next.match_1`. -/
def Color.next : Color → Color
  | .red => .green
  | .green => .blue
  | .blue => .red

/-- A protected theorem: it must be referred to as `Color.red_ne_green`. -/
protected theorem Color.red_ne_green : Color.red ≠ Color.green := fun h => Color.noConfusion h

/-- A point in the plane. -/
structure Point where
  /-- Horizontal coordinate. -/
  x : Nat
  /-- Vertical coordinate. -/
  y : Nat

/-- Things with a size. -/
class HasSize (α : Type) where
  /-- The size. -/
  size : α → Nat

/-- The size of a point is the sum of its coordinates. -/
instance instHasSizePoint : HasSize Point := ⟨fun p => p.x + p.y⟩

/-- A grid is a list of points. -/
abbrev Grid := List Point

/-- A private helper, only visible in this file. -/
private def double (n : Nat) : Nat := 2 * n

/-- Public wrapper around the private helper. -/
def quadruple (n : Nat) : Nat := double (double n)

/-- `quadruple` multiplies by four. -/
theorem quadruple_eq (n : Nat) : quadruple n = 4 * n := by
  unfold quadruple double
  omega

/-- Structural recursion: Lean creates `Toy.sumTo._unsafe_rec` and, on demand, equation lemmas. -/
def sumTo : Nat → Nat
  | 0 => 0
  | n + 1 => (n + 1) + sumTo n

/-- A noncomputable choice. Rests on `Classical.choice` only. -/
noncomputable def pick (α : Type) [h : Nonempty α] : α := Classical.choice h

/-- Unsafe implementation: pointer equality first, then value equality. -/
unsafe def fastEqImpl (a b : Nat) : Bool := ptrAddrUnsafe a == ptrAddrUnsafe b || a == b

/-- Safe reference definition. At runtime it is replaced by the unsafe `fastEqImpl`. -/
@[implemented_by fastEqImpl]
def fastEq (a b : Nat) : Bool := a == b

/-- A `partial def`: the kernel sees only an opaque constant, the compiler runs
`Toy.collatz._unsafe_rec`. -/
partial def collatz (n : Nat) (steps : Nat := 0) : Nat :=
  if n ≤ 1 then steps
  else if n % 2 == 0 then collatz (n / 2) (steps + 1)
  else collatz (3 * n + 1) (steps + 1)

/-- A foreign function. The kernel sees only an opaque constant. -/
@[extern "toy_c_mix"]
opaque cMix : UInt32 → UInt32 → UInt32

/-- An opaque constant with a value the kernel cannot unfold. -/
opaque secret : Nat := 42

end Toy
