/** 品牌与版本配置：由构建期环境变量（VITE_*）注入；未注入时回退内置默认值。 */
const env = ((import.meta as any).env || {}) as Record<string, any>

/** 应用名：侧栏标题、页面 title、页脚。 */
export const BRAND_NAME: string = env.VITE_BRAND_NAME || '英语研习室'
/** 侧栏品牌角标文字（单字）。 */
export const BRAND_MARK: string = env.VITE_BRAND_MARK || '研'
/** 侧栏品牌副标题（一行小字）。 */
export const BRAND_SUB: string = env.VITE_BRAND_SUB || 'CET-4 · CET-6 · 考研'
/** 首页主标语；为空则用内置默认语。 */
export const HERO_SLOGAN: string = env.VITE_HERO_SLOGAN || ''
/** 侧栏底部寄语；为空则用内置默认语。 */
export const SIDEBAR_QUOTE: string = env.VITE_SIDEBAR_QUOTE || ''
/** 页脚显示的版本号。 */
export const APP_VERSION: string = env.VITE_APP_VERSION || 'v1.0'
