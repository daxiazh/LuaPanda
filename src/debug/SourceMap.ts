import { TreeSet } from "tstl/container/TreeSet";

// 保存 TS 文件的有效行号,即这些行号可以映射到编译后的 lua 文件行
type TSFileLines = TreeSet<number>;

/**
 * 支持 TypescriptToLua 生成的 SourceMap
 */
export class SourceMap{
    private static instance: SourceMap;     // 单例
    
    // 缓冲 TS 有效的行号
    private tsVerifiedLines: Map<string, TSFileLines> = new Map<string, TSFileLines>();

    public static getInstance(): SourceMap {
        return this.instance;
    }

    public constructor() {
        SourceMap.instance = this;
    }

    /**
     * 校验指定TS文件指定行真正可以下
     * @param tsFileName 
     * @param line 
     */
    public verifyBreakpoint(tsFileName: string, line: number): number {
        // 先在缓冲中查找
        let info = this.tsVerifiedLines.get(tsFileName);
        if (info) {
            const it = info.lower_bound(line);
            return it.value;
        }

        // 读取对应的SourceMap文件,建立缓冲
        
        return 0;
    }
}