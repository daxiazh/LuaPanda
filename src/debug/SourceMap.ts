import { TreeMap } from "tstl/container/TreeMap"
import * as fs from "fs"
import { Tools } from '../common/tools'
import { DebugLogger } from "../common/logManager";
import { make_pair } from "tstl/utility/Pair";

// 保存 TS 文件的有效行号,即这些行号可以映射到编译后的 lua 文件行
type TSFileLines = TreeMap<number, number>;

export interface SourceLineMapping {
    sourceIndex: number;
    sourceLine: number;
    sourceColumn: number;
}

export interface SourceMap {
    [line: number]: SourceLineMapping | undefined;
    sources: string[];
}

/**
 * 支持 TypescriptToLua 生成的 SourceMap
 */
export namespace SourceMap{
    const cache: { [file: string]: SourceMap | false | undefined } = {};    // 缓冲 lua 文件对应的 SourceMap 信息

    // 缓冲 TS 有效的行号
    const tsVerifiedLines: Map<string, TSFileLines> = new Map<string, TSFileLines>();

    // 用于解码 VLQ，具体见： https://github.com/Rich-Harris/vlq/blob/master/src/vlq.ts
    let charToInteger: { [char: string]: number } = {};
    let integerToChar: { [integer: number]: string } = {};

    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='
        .split('')
        .forEach(function(char, i) {
            charToInteger[char] = i;
            integerToChar[i] = char;
        });

    export function decode(string: string): number[] {
        let result: number[] = [];
        let shift = 0;
        let value = 0;

        for (let i = 0; i < string.length; i += 1) {
            let integer = charToInteger[string[i]];

            if (integer === undefined) {
                throw new Error('Invalid character (' + string[i] + ')');
            }

            // tslint:disable-next-line: no-bitwise
            const hasContinuationBit = integer & 32;

            // tslint:disable-next-line: no-bitwise
            integer &= 31;
            // tslint:disable-next-line: no-bitwise
            value += integer << shift;

            if (hasContinuationBit) {
                shift += 5;
            } else {
                // tslint:disable-next-line: no-bitwise
                const shouldNegate = value & 1;
                // tslint:disable-next-line: no-bitwise
                value >>>= 1;

                if (shouldNegate) {
                    result.push(value === 0 ? -0x80000000 : -value);
                } else {
                    result.push(value);
                }

                // reset
                value = shift = 0;
            }
        }

        return result;
    }

    /**
     * 根据传入的源码映射数据构建缓冲信息
     * @param mappings 源码映射数据，如 ";AAAA,gBAAkB;AAAV;AAEJ,iBAAW;AACf,eAAS;AACC,mBAAS,IAAI;UACP;AAFhB;AAKA"
     */
    function build(mappings: string): {sourceMap: SourceMap, tsFileLines: TSFileLines}{
        let line = 1;
        let sourceIndex = 0;
        let sourceLine = 1;
        let sourceColumn = 1;

        const sourceMap: SourceMap = {sources: []};
        const tsFileLines = new TreeMap<number, number>();      // 保证有效的TS行号及其对应的 lua 行号，即下断点时只可以在这些行中下断点

        // 分隔每一行，每一列的源码映射
        for(const rowMapping of mappings.split(";")){
            if(rowMapping.length > 0){
                for(const colMapping of rowMapping.split(",")){
                    const offsets = decode(colMapping);
                    sourceIndex += (offsets[1] || 0);
                    sourceLine += (offsets[2] || 0);
                    sourceColumn += (offsets[3] || 0);

                    const lineMapping = sourceMap[line];
                    if (!lineMapping
                        || sourceLine < lineMapping.sourceLine
                        || (sourceLine === lineMapping.sourceLine && sourceColumn < lineMapping.sourceColumn)
                    ) {
                        sourceMap[line] = {sourceIndex, sourceLine, sourceColumn};
                    }
                    tsFileLines.insert(make_pair(sourceLine, line));
                }
            }
            line++;
        }
        return {sourceMap, tsFileLines};
    }

    /**
     * 如果传入的文件路径是 ts 文件，则返回对应的 lua 文件路径
     * @param tsFileName 传入要检查的文件路径，有可能是 ts 文件，也有可能不是
     */
    export function verifyLuaFilePath(tsFileName: string): string{
        const tsPath = tsFileName;
        
        if(!tsPath.endsWith(".ts")){
            return tsFileName;
        }

        if(!tsPath.startsWith(Tools.tsRootPath)){
            DebugLogger.showTips(`${tsPath} 并不在 launch.json 中配置的 tsRootPath(${Tools.tsRootPath}) 目录下，无法下断点!`, 2);
            return undefined;
        }

        let luaPath = tsPath.replace(Tools.tsRootPath, Tools.luaRootPath);
        return luaPath.replace(".ts", ".lua");
    }

    /**
     * 校验指定TS文件指定行真正可以下
     * @param tsFileName ts 断点文件路径
     * @param line 断点行号
     * @returns 如果下断点成功，返回对应的断点行号，否则返回 undefined
     */
    export function verifyBreakpoint(tsFileName: string, line: number, luaPath: string): {tsLine: number|undefined, luaLine: number} {
        if(luaPath === undefined){
            return {tsLine: undefined, luaLine: undefined};
        }

        if(tsFileName == luaPath){  // 不是 ts 文件
            return {tsLine: undefined, luaLine: line};
        }
        
        // 先在缓冲中查找
        let info = tsVerifiedLines.get(tsFileName);
        if (info) {
            return getTSFileLine(info, line);
        }

        // 读取 sourcemap 文件
        const mapFilePath = luaPath + ".map";
        if(!fs.existsSync(mapFilePath)){
            DebugLogger.showTips(`${mapFilePath} 文件不存在，无法下断点\n注意确认 launch.json 配置的 tsRootPath 与 luaRootPath 目录正确!`, 2);
            return {tsLine: undefined, luaLine: undefined};
        }

        const fileData = fs.readFileSync(mapFilePath, 'utf-8');
        const mapData = JSON.parse(fileData) as {mappings:string, sources: string[]};
        if(!mapData.mappings || !mapData.sources){
            return {tsLine: undefined, luaLine: undefined};
        }

        const result = build(mapData.mappings);
        cache[luaPath] = result.sourceMap;
        tsVerifiedLines.set(tsFileName, result.tsFileLines);

        return getTSFileLine(result.tsFileLines, line);

        function getTSFileLine(_lines: TSFileLines, inputLine: number){
            if(_lines.size() === 0){
                return {tsLine: undefined, luaLine: undefined};
            }

            const it = _lines.lower_bound(inputLine);
            if(it === _lines.end()){
                return {tsLine: it.prev().first, luaLine: it.prev().second};
            }

            return {tsLine: it.first, luaLine: it.second};
        }
    }
}