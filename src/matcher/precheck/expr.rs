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

/// A cheap leaf: a plain check function against the source context plus a
/// caller-supplied metadata `M` describing what it checks, surfaced by
/// [`CheapExpr::for_each_leaf`]. `M` is business-agnostic: the concrete builder
/// decides what it carries (e.g. host vs path vs prefix) without `expr.rs`
/// knowing anything about it. The check function receives `M` explicitly rather
/// than capturing it, so `M` stays free to be `Clone`/`Debug`/etc.
pub struct Leaf<C: ?Sized, M> {
  pub meta: M,
  pub check: fn(&C, &M) -> bool,
}

impl<C: ?Sized, M> Leaf<C, M> {
  pub fn new(meta: M, check: fn(&C, &M) -> bool) -> Self {
    Self { meta, check }
  }
}

/// A boolean combination of cheap checks.
///
/// A leaf is a closure `fn(&C) -> bool` against the source context, so adding a
/// new cheap capability only means constructing one more leaf in the builder;
/// the tree and evaluator never change. Leaves that cannot be partially
/// evaluated (headers, regex, JWT, ...) are collapsed into [`CheapExpr::Unknown`].
///
/// This type is pure computation: it knows nothing about CEL or concrete
/// sources (`eval` only invokes the leaf closures, which are supplied by the
/// concrete builder). `M` is a caller-supplied leaf metadata type, defaulting
/// to `()` for callers that only evaluate. [`CheapExpr::eval`] is sound under
/// Kleene's three-valued logic, so:
///
/// - `True` always means the full rule is true (no further evaluation needed),
/// - `False` always means the full rule is false (safe to reject),
/// - `Unknown` requires the full rule to be evaluated.
pub enum CheapExpr<C: ?Sized, M = ()> {
  And(Box<CheapExpr<C, M>>, Box<CheapExpr<C, M>>),
  Or(Box<CheapExpr<C, M>>, Box<CheapExpr<C, M>>),
  Not(Box<CheapExpr<C, M>>),
  Cond(
    Box<CheapExpr<C, M>>,
    Box<CheapExpr<C, M>>,
    Box<CheapExpr<C, M>>,
  ),
  Check(Leaf<C, M>),
  Lit(bool),
  Unknown,
}

impl<C: ?Sized, M> CheapExpr<C, M> {
  /// Whether the tree contains no `Unknown` leaf, i.e. [`CheapExpr::eval`] is
  /// exact and never returns `Tri::Unknown`.
  pub fn is_complete(&self) -> bool {
    match self {
      CheapExpr::And(a, b) => a.is_complete() && b.is_complete(),
      CheapExpr::Or(a, b) => a.is_complete() && b.is_complete(),
      CheapExpr::Not(inner) => inner.is_complete(),
      CheapExpr::Cond(cond, then, els) => {
        cond.is_complete() && then.is_complete() && els.is_complete()
      }
      CheapExpr::Check(_) | CheapExpr::Lit(_) => true,
      CheapExpr::Unknown => false,
    }
  }

  /// Visits every [`CheapExpr::Check`] leaf, exposing its metadata so the
  /// caller can collect constraints from the built tree.
  pub fn for_each_leaf<F: FnMut(&M)>(&self, f: &mut F) {
    match self {
      CheapExpr::And(a, b) => {
        a.for_each_leaf(f);
        b.for_each_leaf(f);
      }
      CheapExpr::Or(a, b) => {
        a.for_each_leaf(f);
        b.for_each_leaf(f);
      }
      CheapExpr::Not(inner) => inner.for_each_leaf(f),
      CheapExpr::Cond(cond, then, els) => {
        cond.for_each_leaf(f);
        then.for_each_leaf(f);
        els.for_each_leaf(f);
      }
      CheapExpr::Check(leaf) => f(&leaf.meta),
      CheapExpr::Lit(_) | CheapExpr::Unknown => {}
    }
  }

  /// Evaluates the constraint under Kleene's three-valued logic.
  pub fn eval(&self, ctx: &C) -> Tri {
    match self {
      CheapExpr::And(a, b) => tri_and(a.eval(ctx), b.eval(ctx)),
      CheapExpr::Or(a, b) => tri_or(a.eval(ctx), b.eval(ctx)),
      CheapExpr::Not(inner) => tri_not(inner.eval(ctx)),
      CheapExpr::Cond(cond, then, els) => tri_cond(cond.eval(ctx), then.eval(ctx), els.eval(ctx)),
      CheapExpr::Check(leaf) => from_bool((leaf.check)(ctx, &leaf.meta)),
      CheapExpr::Lit(v) => from_bool(*v),
      CheapExpr::Unknown => Tri::Unknown,
    }
  }
}
