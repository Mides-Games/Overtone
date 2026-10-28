/**
 * The side gutter (docs/design.md, section 4): 16 px on a phone growing to 24
 * on a wide screen, or more where a phone's system bar sits at the side.
 */
export const gutter = {
  paddingLeft: 'max(clamp(16px, 4vw, 24px), env(safe-area-inset-left, 0px))',
  paddingRight: 'max(clamp(16px, 4vw, 24px), env(safe-area-inset-right, 0px))',
}
