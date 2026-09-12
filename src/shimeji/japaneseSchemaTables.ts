/**
 * The original Japanese Shimeji schema, mapped onto the English one shimeji-ee uses.
 *
 * Generated, not written: every entry below was produced by walking the unmodified Japanese default
 * configuration (動作.xml / 行動.xml, as shipped in the downloaded packs) and the English default in
 * Shimeji/conf node by node. The two are the same document in two languages — 466 and 88 nodes, and
 * the same attributes on every one — so each pair of aligned tags, attribute names and values *is*
 * a translation, with nothing inferred. Every key maps to exactly one value in that alignment.
 *
 * Deliberately absent: `Frequency`. Two frequencies differ between the two files, and those are the
 * Japanese pack's own tuning rather than language — translating them would quietly change how a
 * character behaves.
 */

/** Element names. */
export const JA_TAGS: Record<string, string> = {
	"マスコット": "Mascot",
	"動作リスト": "ActionList",
	"動作": "Action",
	"アニメーション": "Animation",
	"ポーズ": "Pose",
	"動作参照": "ActionReference",
	"行動リスト": "BehaviorList",
	"行動": "Behavior",
	"次の行動リスト": "NextBehavior",
	"行動参照": "BehaviorReference",
	"条件": "Condition",
};

/** Attribute names. Also the parameter names a condition can refer to — see JA_EXPRESSION_WORDS. */
export const JA_ATTRS: Record<string, string> = {
	"名前": "Name",
	"種類": "Type",
	"クラス": "Class",
	"枠": "BorderType",
	"画像": "Image",
	"基準座標": "ImageAnchor",
	"移動速度": "Velocity",
	"長さ": "Duration",
	"条件": "Condition",
	"IEの端X": "IeOffsetX",
	"IEの端Y": "IeOffsetY",
	"初速X": "InitialVX",
	"初速Y": "InitialVY",
	"重力": "Gravity",
	"速度": "VelocityParam",
	"空気抵抗X": "RegistanceX",
	"空気抵抗Y": "RegistanceY",
	"繰り返し": "Loop",
	"目的地X": "TargetX",
	"右向き": "LookRight",
	"目的地Y": "TargetY",
	"ずれ": "Gap",
	"生まれる場所X": "BornX",
	"生まれる場所Y": "BornY",
	"生まれた時の行動": "BornBehavior",
	"頻度": "Frequency",
	"追加": "Add",
};

/** Values of `Type` (Japanese `種類`). */
export const JA_ACTION_TYPES: Record<string, string> = {
	"組み込み": "Embedded",
	"静止": "Stay",
	"移動": "Move",
	"固定": "Animate",
	"複合": "Sequence",
	"選択": "Select",
};

/** Values of `BorderType` (Japanese `枠`). */
export const JA_BORDER_TYPES: Record<string, string> = {
	"地面": "Floor",
	"天井": "Ceiling",
	"壁": "Wall",
};

/**
 * The standard action and behaviour names. These matter beyond tidiness: the engine asks for some of
 * them by their English name — Fall, Dragged, Thrown, ChaseMouse — and a pack that still called them
 * 落下する could never be picked up or dropped. A name not in this table is the pack's own invention
 * and is left exactly as written; every reference to it is left too, so it stays consistent.
 */
export const JA_NAMES: Record<string, string> = {
	"振り向く": "Look",
	"変位": "Offset",
	"立つ": "Stand",
	"歩く": "Walk",
	"走る": "Run",
	"猛ダッシュ": "Dash",
	"座る": "Sit",
	"座って見上げる": "SitAndLookUp",
	"座ってマウスを見上げる": "SitAndLookAtMouse",
	"座って首が回る": "SitAndSpinHeadAction",
	"楽に座る": "SitWithLegsUp",
	"足を下ろして座る": "SitWithLegsDown",
	"足をぶらぶらさせる": "SitAndDangleLegs",
	"寝そべる": "Sprawl",
	"ずりずり": "Creep",
	"天井に掴まる": "GrabCeiling",
	"天井を伝う": "ClimbCeiling",
	"壁に掴まる": "GrabWall",
	"壁を登る": "ClimbWall",
	"IEを持って落ちる": "FallWithIe",
	"IEを持って歩く": "WalkWithIe",
	"IEを持って走る": "RunWithIe",
	"IEを投げる": "ThrowIe",
	"ジャンプ": "Jumping",
	"落ちる": "Falling",
	"跳ねる": "Bouncing",
	"転ぶ": "Tripping",
	"つままれる": "Pinched",
	"抵抗する": "Resisting",
	"落下する": "Fall",
	"ドラッグされる": "Dragged",
	"投げられる": "Thrown",
	"立ってボーっとする": "StandUp",
	"座ってボーっとする": "SitDown",
	"寝そべってボーっとする": "LieDown",
	"座って足をぶらぶらさせる": "SitWhileDanglingLegs",
	"壁に掴まってボーっとする": "HoldOntoWall",
	"壁から落ちる": "FallFromWall",
	"天井に掴まってボーっとする": "HoldOntoCeiling",
	"天井から落ちる": "FallFromCeiling",
	"ワークエリアの下辺を歩く": "WalkAlongWorkAreaFloor",
	"ワークエリアの下辺を走る": "RunAlongWorkAreaFloor",
	"ワークエリアの下辺でずりずり": "CrawlAlongWorkAreaFloor",
	"ワークエリアの下辺の左の端っこで座る": "WalkLeftAlongFloorAndSit",
	"ワークエリアの下辺の右の端っこで座る": "WalkRightAlongFloorAndSit",
	"ワークエリアの下辺から左の壁によじのぼる": "GrabWorkAreaBottomLeftWall",
	"ワークエリアの下辺から右の壁によじのぼる": "GrabWorkAreaBottomRightWall",
	"走ってワークエリアの下辺の左の端っこで座る": "WalkLeftAndSit",
	"走ってワークエリアの下辺の右の端っこで座る": "WalkRightAndSit",
	"走ってワークエリアの下辺から左の壁によじのぼる": "WalkAndGrabBottomLeftWall",
	"走ってワークエリアの下辺から右の壁によじのぼる": "WalkAndGrabBottomRightWall",
	"IEの下に飛びつく": "JumpFromBottomOfIE",
	"ワークエリアの壁を途中まで登る": "ClimbHalfwayAlongWall",
	"ワークエリアの壁を登る": "ClimbAlongWall",
	"ワークエリアの上辺を伝う": "ClimbAlongCeiling",
	"IEの天井を歩く": "WalkAlongIECeiling",
	"IEの天井を走る": "RunAlongIECeiling",
	"IEの天井でずりずり": "CrawlAlongIECeiling",
	"IEの天井の左の端っこで座る": "SitOnTheLeftEdgeOfIE",
	"IEの天井の右の端っこで座る": "SitOnTheRightEdgeOfIE",
	"IEの天井の左の端っこから飛び降りる": "JumpFromLeftEdgeOfIE",
	"IEの天井の右の端っこから飛び降りる": "JumpFromRightEdgeOfIE",
	"走ってIEの天井の左の端っこで座る": "WalkLeftAlongIEAndSit",
	"走ってIEの天井の右の端っこで座る": "WalkRightAlongIEAndSit",
	"走ってIEの天井の左の端っこから飛び降りる": "WalkLeftAlongIEAndJump",
	"走ってIEの天井の右の端っこから飛び降りる": "WalkRightAlongIEAndJump",
	"猛ダッシュでIEの天井の左の端っこから飛び降りる": "DashIeCeilingLeftEdgeFromJump",
	"猛ダッシュでIEの天井の右の端っこから飛び降りる": "DashIeCeilingRightEdgeFromJump",
	"IEの壁を途中まで登る": "HoldOntoIEWall",
	"IEの壁を登る": "ClimbIEWall",
	"IEの下辺を伝う": "ClimbIEBottom",
	"IEの下辺から左の壁によじのぼる": "GrabIEBottomLeftWall",
	"IEの下辺から右の壁によじのぼる": "GrabIEBottomRightWall",
	"左の壁に飛びつく": "JumpFromLeftWall",
	"右の壁に飛びつく": "JumpFromRightWall",
	"IEの左に飛びつく": "JumpOnIELeftWall",
	"IEの右に飛びつく": "JumpOnIERightWall",
	"IEを右に投げる": "ThrowIEFromLeft",
	"IEを左に投げる": "ThrowIEFromRight",
	"走ってIEを右に投げる": "WalkAndThrowIEFromRight",
	"走ってIEを左に投げる": "WalkAndThrowIEFromLeft",
	"マウスの周りに集まる": "ChaseMouse",
	"座ってマウスのほうを見る": "SitAndFaceMouse",
	"座ってマウスのほうを見てたら首が回った": "SitAndSpinHead",
	"引っこ抜く1": "PullUpShimeji1",
	"引っこ抜かれる": "PullUp",
	"引っこ抜く2": "PullUpShimeji2",
	"引っこ抜く": "PullUpShimeji",
	"分裂1": "Divide1",
	"分裂した": "Divided",
	"分裂する": "SplitIntoTwo",
};
