import Lake
open Lake DSL

/- A block comment mentioning lean_lib Commented
   /- nested -/ still a comment -/

package «toy lean» where
  srcDir := "lib"
  leanOptions := #[⟨`autoImplicit, false⟩]

-- lean_lib NotALib
@[default_target]
lean_lib «Toy» where
  -- roots default to the library name

lean_lib Extra where
  srcDir := "extra"
  roots := #[`Extra.A, `Extra.«B c»]

lean_exe toycli where
  root := `Main
