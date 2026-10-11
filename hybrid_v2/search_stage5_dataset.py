
from __future__ import annotations
import argparse, json, math
from pathlib import Path
import numpy as np
import torch
from .common import read_jsonl, torch_load, l2norm, jaccard, zscore1d
from .text_encoder import BGEEncoder
from .query_encoder import SigLIPQueryEncoder
from .stage5_model import Stage5HybridReranker
from .vlm_client import VLLMClient

QUERY_PROMPT="""Parse this dashcam scene-search query into JSON only.
Query: {query}
Schema:
{{"action":"short requested action or empty","relation":"short spatial/directional relation or empty","context":"road/weather/traffic context or empty"}}
Do not add information that is not in the query."""

def join_list(x): return "; ".join([str(v) for v in (x or []) if str(v).strip()])
def cap_fields(r):
    action="; ".join(x for x in [r.get("ego_action",""),join_list(r.get("other_actions")),join_list(r.get("events"))] if x)
    relation=join_list(r.get("relations"))
    context="; ".join(x for x in [join_list(r.get("road_context")),join_list(r.get("traffic_control")),r.get("weather","")] if x)
    return r.get("description",""),action,relation,context
def rr(rank): return 0.0 if rank<1 else 1.0/math.log2(rank+1.0)

def parse_args():
    p=argparse.ArgumentParser()
    p.add_argument("--query",required=True)
    p.add_argument("--split",choices=["train","val","test"],default="test")
    p.add_argument("--top-k",type=int,default=10)
    p.add_argument("--rerank-k",type=int,default=50)
    p.add_argument("--caption-k",type=int,default=100)
    p.add_argument("--stage3-k",type=int,default=100)
    p.add_argument("--stage2a-cache-dir",default="./outputs/driveretriever_stage2a_cache")
    p.add_argument("--stage4-cache-dir",default="./outputs/driveretriever_stage4_cache")
    p.add_argument("--frame-cache-dir",default="./outputs/driveretriever_stage4b_frame_cache")
    p.add_argument("--stage2b-checkpoint",default="./outputs/driveretriever_stage2b_vision/best_composite.pt")
    p.add_argument("--output-dir",default="./outputs/driveretriever_hybrid_v2")
    p.add_argument("--checkpoint",default="")
    p.add_argument("--base-url",default="http://127.0.0.1:8000/v1")
    p.add_argument("--vlm-model",default="Qwen/Qwen3-VL-4B-Instruct")
    p.add_argument("--no-vlm-parse",action="store_true")
    p.add_argument("--device",default="cuda")
    return p.parse_args()

@torch.inference_mode()
def main():
    a=parse_args(); dev=torch.device(a.device if torch.cuda.is_available() else "cpu")
    root=Path(a.output_dir); sp=a.split
    captions=read_jsonl(root/"captions"/sp/"captions.jsonl")
    manifest=read_jsonl(Path(a.stage2a_cache_dir)/sp/"clips.jsonl")
    full=np.load(root/"text_index"/sp/"caption_full.npy",mmap_mode="r")
    act=np.load(root/"text_index"/sp/"caption_action.npy",mmap_mode="r")
    rel=np.load(root/"text_index"/sp/"caption_relation.npy",mmap_mode="r")
    ctx=np.load(root/"text_index"/sp/"caption_context.npy",mmap_mode="r")
    fused=np.load(Path(a.stage4_cache_dir)/sp/"fused_embeddings.npy",mmap_mode="r")
    pframes=np.load(Path(a.frame_cache_dir)/sp/"frame_embeddings.npy",mmap_mode="r")
    rawframes=np.load(Path(a.stage2a_cache_dir)/sp/"frame_features.npy",mmap_mode="r")

    intent={"action":"","relation":"","context":""}
    if not a.no_vlm_parse:
        try:
            x=VLLMClient(a.base_url,a.vlm_model).chat_json(QUERY_PROMPT.format(query=a.query),max_tokens=160,temperature=0)
            for k in intent: intent[k]=str(x.get(k,"") or "")
        except Exception as e:
            print("[warn] VLM query parse failed; using raw query only:",e)
    print("[intent]",json.dumps(intent,ensure_ascii=False))

    bge=BGEEncoder(device=a.device)
    qfull,qact,qrel,qctx=[
        bge.encode([x])[0] for x in [a.query,intent["action"] or "none",intent["relation"] or "none",intent["context"] or "none"]
    ]
    sig=SigLIPQueryEncoder(a.stage2b_checkpoint,a.device)
    qraw,qproj=sig.encode([a.query]); qraw=qraw[0]; qproj=qproj[0]

    cap_score=l2norm(np.asarray(full,np.float32))@qfull
    stage_score=l2norm(np.asarray(fused,np.float32))@qproj
    ci=np.argsort(-cap_score,kind="stable")[:a.caption_k]
    si=np.argsort(-stage_score,kind="stable")[:a.stage3_k]
    rc={int(j):r+1 for r,j in enumerate(ci)}; rs={int(j):r+1 for r,j in enumerate(si)}
    union=set(rc)|set(rs)
    def rrf(j): return (1/(60+rc[j]) if j in rc else 0)+(1/(60+rs[j]) if j in rs else 0)
    cand=np.array(sorted(union,key=lambda j:(-rrf(j),j))[:a.rerank_k],dtype=np.int64)

    feats=[]
    for j in cand:
        cf=np.asarray(full[j],np.float32); ca=np.asarray(act[j],np.float32); rrn=np.asarray(rel[j],np.float32); cc=np.asarray(ctx[j],np.float32)
        fu = np.asarray(fused[j], dtype=np.float32)
        fu = fu / (np.linalg.norm(fu) + 1e-8)
        pf = np.asarray(pframes[j], dtype=np.float32)
        pf = pf / np.maximum(
            np.linalg.norm(pf, axis=-1, keepdims=True),
            1e-8
        )
        ps=pf@qproj
        rf = np.asarray(rawframes[j], dtype=np.float32)
        rf = rf / np.maximum(
            np.linalg.norm(rf, axis=-1, keepdims=True),
            1e-8
        )
        rsi=rf@qraw
        desc,ca_txt,cr_txt,cc_txt=cap_fields(captions[j])
        ac=float(qact@ca) if intent["action"] else 0.0
        re=float(qrel@rrn) if intent["relation"] else 0.0
        co=float(qctx@cc) if intent["context"] else 0.0
        c=float(qfull@cf); s=float(qproj@fu)
        feats.append([
            c,ac,re,co,s,float(ps.max()),float(np.sort(ps)[-min(3,len(ps)):].mean()),float(ps.mean()),
            float(rsi.max()),float(np.sort(rsi)[-min(3,len(rsi)):].mean()),float(rsi.mean()),
            rr(rc.get(int(j),-1)),rr(rs.get(int(j),-1)),jaccard(a.query,desc),
            jaccard(intent["action"],ca_txt) if intent["action"] else 0.0,
            jaccard(intent["relation"],cr_txt) if intent["relation"] else 0.0,c*s,ac*re
        ])
    X=np.asarray(feats,np.float32)
    comps=[(.30,X[:,0]),(.20,X[:,4]),(.15,X[:,6]),(.15,X[:,1]),(.10,X[:,2]),(.10,X[:,3])]
    base=np.zeros(len(X),np.float32)
    for w,x in comps: base+=w*zscore1d(x)

    ckpath=Path(a.checkpoint) if a.checkpoint else root/"stage5"/"best_stage5.pt"
    ck=torch_load(ckpath)
    XX=(X-np.asarray(ck["feature_mean"],np.float32))/np.asarray(ck["feature_std"],np.float32)
    cfg=ck["config"]
    model=Stage5HybridReranker(len(ck["feature_names"]),int(cfg["hidden"]),float(cfg["dropout"]),float(cfg["residual_scale"])).to(dev)
    model.load_state_dict(ck["model_state_dict"]); model.eval()
    res=model.residual(torch.from_numpy(XX)[None].to(dev))[0].float().cpu().numpy()
    final=base+float(ck["alpha"])*res
    order=np.argsort(-final,kind="stable")
    print("="*110); print("QUERY:",a.query); print("="*110)
    for rank,ii in enumerate(order[:a.top_k],1):
        j=int(cand[ii]); r=manifest[j]
        print(f"\n#{rank:02d} clip={r['clip_id']}  final={final[ii]:.4f} base={base[ii]:.4f} cap={X[ii,0]:.4f} s3={X[ii,4]:.4f}")
        print("   generated_caption:",captions[j].get("description",""))
        tv=r.get("text_variants") or []
        if tv: print("   original_caption:",tv[0])

if __name__=="__main__": main()
