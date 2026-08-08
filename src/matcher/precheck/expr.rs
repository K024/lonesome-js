/// Three-valued result of a cheap pre-check.
///
/// - `True`: true under every completion of the unknown leaves.
/// - `False`: false under every completion; safe to reject without running CEL.
/// - `Unknown`: depends on the unknown leaves; the full CEL program must decide.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tri {
  True,
  False,
  Unknown,
}

pub(crate) fn from_bool(v: bool) -> Tri {
  if v {
    Tri::True
  } else {
    Tri::False
  }
}

pub(crate) fn tri_and(a: Tri, b: Tri) -> Tri {
  if matches!(a, Tri::False) || matches!(b, Tri::False) {
    Tri::False
  } else if matches!(a, Tri::Unknown) || matches!(b, Tri::Unknown) {
    Tri::Unknown
  } else {
    Tri::True
  }
}

pub(crate) fn tri_or(a: Tri, b: Tri) -> Tri {
  if matches!(a, Tri::True) || matches!(b, Tri::True) {
    Tri::True
  } else if matches!(a, Tri::Unknown) || matches!(b, Tri::Unknown) {
    Tri::Unknown
  } else {
    Tri::False
  }
}

pub(crate) fn tri_not(a: Tri) -> Tri {
  match a {
    Tri::True => Tri::False,
    Tri::False => Tri::True,
    Tri::Unknown => Tri::Unknown,
  }
}

pub(crate) fn tri_cond(cond: Tri, then: Tri, els: Tri) -> Tri {
  match cond {
    Tri::True => then,
    Tri::False => els,
    Tri::Unknown => {
      if then == els {
        then
      } else {
        Tri::Unknown
      }
    }
  }
}

/// A boolean combination of cheap checks.
///
/// A leaf is a closure `fn(&C) -> bool` against the source context, so adding a
/// new cheap capability only means constructing one more leaf in the builder;
/// the tree and evaluator never change. Leaves that cannot be partially
/// evaluated (headers, regex, JWT, ...) are collapsed into [`CheapExpr::Unknown`].
///
/// This type is pure computation: it knows nothing about CEL, concrete sources
/// or even how leaves read their inputs (`eval` only invokes the leaf closures,
/// which are supplied by the concrete builder). [`CheapExpr::eval`] is sound
/// under Kleene's three-valued logic, so:
///
/// - `True` always means the full rule is true (no further evaluation needed),
/// - `False` always means the full rule is false (safe to reject),
/// - `Unknown` requires the full rule to be evaluated.
pub enum CheapExpr<C: ?Sized> {
  And(Box<CheapExpr<C>>, Box<CheapExpr<C>>),
  Or(Box<CheapExpr<C>>, Box<CheapExpr<C>>),
  Not(Box<CheapExpr<C>>),
  Cond(Box<CheapExpr<C>>, Box<CheapExpr<C>>, Box<CheapExpr<C>>),
  Check(Box<dyn Fn(&C) -> bool + Send + Sync>),
  Lit(bool),
  Unknown,
}

impl<C: ?Sized> CheapExpr<C> {
  /// Evaluates the constraint under Kleene's three-valued logic.
  pub fn eval(&self, ctx: &C) -> Tri {
    match self {
      CheapExpr::And(a, b) => tri_and(a.eval(ctx), b.eval(ctx)),
      CheapExpr::Or(a, b) => tri_or(a.eval(ctx), b.eval(ctx)),
      CheapExpr::Not(inner) => tri_not(inner.eval(ctx)),
      CheapExpr::Cond(cond, then, els) => tri_cond(cond.eval(ctx), then.eval(ctx), els.eval(ctx)),
      CheapExpr::Check(f) => from_bool(f(ctx)),
      CheapExpr::Lit(v) => from_bool(*v),
      CheapExpr::Unknown => Tri::Unknown,
    }
  }
}
