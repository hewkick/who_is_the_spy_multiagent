import os
import random
import time
import json
import re
from flask import Flask, render_template, request, Response
from openai import OpenAI
from dotenv import load_dotenv

# 加载环境变量
# 请确保您在项目根目录下有一个 .env 文件，并正确配置了您的 API 密钥
# 在 dotenv_path 中输入您的 .env 文件路径
load_dotenv(verbose=True, dotenv_path="api_env.env") 

# 初始化 Flask app
app = Flask(__name__, template_folder='.')

# 使用的模型名称
MODEL_NAME = 'doubao-seed-1-6-250615' 

# AI的核心指令 - 发言环节
SYSTEM_PROMPT = '''
你是一个"谁是卧底"游戏的AI玩家。

游戏规则：
- 游戏中有多个玩家，其中一个是“卧底”，其余是“平民”。
- 平民和卧底会拿到相似但不同的词语。
- 你不知道自己的具体身份（是平民还是卧底）。
- 你的目标是：如果你是平民，找出卧底；如果你是卧底，隐藏自己。

发言要求：
1.  **模糊描述**：用一两个词语或短语描述你手中的词语，为了避免暴露，你可以选用一些很宽泛的词语。例如使用“吸水工具”来描述“毛巾”。但**绝对不能**说出词语本身。
2.  **避免重复**：你的描述不能和场上任何一个已经出现过的描述完全重复，但在词义上可以适当重叠。
3.  **隐藏身份**：你的描述要足够巧妙，既能表达你的词语，又不会轻易暴露。
4.  **误导对手（高级技巧）**：如果你猜到自己是卧底，可以尝试描述平民的词语来混淆视听。例如，如果你发现大部分人的描述信息都与你所持词语不匹配，你就应该认真考虑一下自己是不是卧底了。
5.  **胜利至上**：你的最终目标是赢得游戏。

现在是第 {current_round} 轮, 你是 **玩家{player_number}**, 你的词语是 **"{player_word}"**。
场上还剩下这些玩家: {active_players_list}
请参考以下之前的对话历史，给出你这一轮的描述。在你的深度思考过程中，务必不要过度思考。

对话历史:
{previous_conversations}

你的描述:
'''

# AI的核心指令 - 投票环节
AI_VOTE_PROMPT = """
你是一个"谁是卧底"游戏的AI玩家，现在是投票环节。
你的任务是根据所有人的发言，找出最可疑的玩家并投票给他。

游戏规则回顾:
- 游戏中有“平民”和“卧底”。
- 平民和卧底的词语相似但不同。
- 你的目标是：如果你是平民，找出卧底；如果你是卧底，隐藏自己并误导他人。
- 重要的是，你需要先猜测自己是平民还是卧底，以防闹出乌龙。

现在是投票环节, 你是 **玩家{player_number}**, 你的词语是 **"{player_word}"**。
你不能投自己。你可以投票的玩家编号是: {other_player_ids}

请分析以下所有人的发言历史:
{all_conversations}

如果你实在无法笃定，就投你认为最有可能的那一位，务必不要过度思考。

**注意**，请**直接**给出你的最终决定，例如：“所以我最终投票给玩家X。”
"""

# 全局游戏状态变量
game_state = {}

def initialize_game(total_players=4, num_undercover=1):
    """
    初始化一个新的游戏状态。
    """
    global game_state
    
    word_pairs = [("牛奶", "豆浆"), ("画家", "作家"), ("手机", "相机"), ("包子", "馒头"), ("薯条", "薯片"), ("毛巾", "手帕"), ("太阳", "月亮")]
    selected_pair = random.choice(word_pairs)
    
    if random.random() > 0.5:
        civilian_word, undercover_word = selected_pair
    else:
        undercover_word, civilian_word = selected_pair
    
    num_civilians = total_players - num_undercover
    words = ([civilian_word] * num_civilians) + ([undercover_word] * num_undercover)
    random.shuffle(words)

    game_state = {
        "words": words,
        "undercover_word": undercover_word,
        "civilian_word": civilian_word,
        "players": [
            { 
                "id": i + 1, 
                "name": f'AI玩家{i + 1}', 
                "role": '平民' if words[i] != undercover_word else '卧底', 
                "isUndercover": words[i] == undercover_word, 
                "word": words[i],
                "active": True
            }
            for i in range(total_players)
        ],
        "current_round": 1,
        "discussion": [],
        "votes": {},
        "game_over": False,
        "winner": None,
        "result_message": ""
    }

def get_ai_description_stream(player_number, player_word, current_round, previous_conversations, active_players_list):
    prompt = SYSTEM_PROMPT.format(
        current_round=current_round,
        player_number=player_number,
        player_word=player_word,
        previous_conversations=previous_conversations if previous_conversations else "现在是第一轮，还没有人发言。",
        active_players_list=active_players_list
    )
    return call_ai_stream(prompt)

def get_ai_vote_stream(player, all_conversations, other_player_ids):
    prompt = AI_VOTE_PROMPT.format(
        player_number=player["id"],
        player_word=player["word"],
        other_player_ids=other_player_ids,
        all_conversations=all_conversations
    )
    return call_ai_stream(prompt)

def call_ai_stream(prompt):
    """
    通用的AI模型流式调用函数, 现在可以处理深度思考内容。
    """
    try:
        api_key = os.environ.get("ARK_API_KEY")
        if not api_key:
            yield "Error: API key not configured. Please set the ARK_API_KEY environment variable."
            return

        client = OpenAI(
            base_url="https://ark.cn-beijing.volces.com/api/v3",
            api_key=api_key,
        )
        
        messages=[
            {"role": "system", "content": "你是一名精通“谁是卧底”游戏的高手。"},
            {"role": "user", "content": prompt}
        ]

        response = client.chat.completions.create(
            model=MODEL_NAME,
            messages=messages,
            stream=True,
        )

        for chunk in response:
            yield chunk

    except Exception as e:
        print(f"Error calling AI API: {e}")
        yield f"Error: {e}"

def parse_vote_from_text(text, voter_id, all_player_ids):
    possible_targets = [pid for pid in all_player_ids if pid != voter_id]
    if not possible_targets:
        return None 

    match = re.search(r'投票给玩家\s*(\d+)', text)
    if not match:
        match = re.search(r'投给玩家\s*(\d+)', text)
    if not match:
        match = re.search(r'投玩家\s*(\d+)', text)
    if not match:
        match = re.search(r'玩家\s*(\d+)', text.split('。')[-1])

    if match:
        try:
            voted_id = int(match.group(1))
            if voted_id in possible_targets:
                return voted_id
        except (ValueError, IndexError):
            pass

    return random.choice(possible_targets)

def stream_ai_response(stream_generator, player_id, player_name, round_num=None):
    """
    一个辅助函数，用于处理来自AI的流式响应并生成JSON事件。
    会同时处理 message_chunk 和 reasoning_chunk。
    """
    content = ""
    reasoning_content = ""
    
    yield f"data: {json.dumps({'type': 'message_start', 'playerId': player_id, 'name': player_name})}\n\n"

    for chunk in stream_generator:
        if isinstance(chunk, str) and chunk.startswith("Error:"):
            error_content = chunk
            yield f"data: {json.dumps({'type': 'message_chunk', 'content': error_content})}\n\n"
            content = error_content
            break
        
        if hasattr(chunk.choices[0].delta, 'reasoning_content') and chunk.choices[0].delta.reasoning_content:
            chunk_text = chunk.choices[0].delta.reasoning_content
            reasoning_content += chunk_text
            yield f"data: {json.dumps({'type': 'reasoning_chunk', 'reasoning_content': chunk_text})}\n\n"
        elif chunk.choices[0].delta.content:
            chunk_text = chunk.choices[0].delta.content or ""
            content += chunk_text
            yield f"data: {json.dumps({'type': 'message_chunk', 'content': chunk_text})}\n\n"

    discussion_entry = {"playerId": player_id, "name": player_name, "content": content, "reasoning": reasoning_content}
    if round_num is not None:
        discussion_entry["round"] = round_num
    game_state["discussion"].append(discussion_entry)

    yield f"data: {json.dumps({'type': 'message_end'})}\n\n"
    return content


@app.route('/')
def index():
    return render_template('Who_is_the_Spy_page.html')

def stream_game_events(total_players, num_undercover, max_rounds):
    initialize_game(total_players, num_undercover)
    game_state['max_rounds'] = max_rounds

    start_data = {
        'type': 'start', 
        'players': game_state['players']
    }
    yield f"data: {json.dumps(start_data)}\n\n"
    time.sleep(1)

    round_number = 1
    while not game_state["game_over"]:
        # --- Check win/loss conditions at the START of the loop ---
        active_players = [p for p in game_state["players"] if p["active"]]
        active_player_ids = [p['id'] for p in active_players]
        active_civilians = [p for p in active_players if not p['isUndercover']]
        active_undercover = [p for p in active_players if p['isUndercover']]

        if not active_undercover:
            game_state["game_over"] = True
            game_state["winner"] = "平民"
            game_state["result_message"] = f"所有卧底均已被找出，平民获得胜利！卧底词是“{game_state['undercover_word']}”，平民词是“{game_state['civilian_word']}”。"
            yield f"data: {json.dumps({'type': 'end', 'winner': game_state['winner'], 'result_message': game_state['result_message'], 'players': game_state['players'], 'votes': game_state.get('votes', {})})}\n\n"
            break

        if len(active_undercover) >= len(active_civilians):
            game_state["game_over"] = True
            game_state["winner"] = "卧底"
            game_state["result_message"] = f"场上卧底人数已占优，卧底自动胜利！卧底词是“{game_state['undercover_word']}”，平民词是“{game_state['civilian_word']}”。"
            yield f"data: {json.dumps({'type': 'end', 'winner': game_state['winner'], 'result_message': game_state['result_message'], 'players': game_state['players'], 'votes': game_state.get('votes', {})})}\n\n"
            break

        # --- Check for max rounds BEFORE starting the round's actions ---
        if max_rounds > 0 and round_number > max_rounds:
            game_state["game_over"] = True
            game_state["winner"] = "卧底"
            game_state["result_message"] = f"已达到最大回合数 ({max_rounds}轮)，卧底仍未被找出，卧底胜利！卧底词是“{game_state['undercover_word']}”，平民词是“{game_state['civilian_word']}”。"
            yield f"data: {json.dumps({'type': 'end', 'winner': game_state['winner'], 'result_message': game_state['result_message'], 'players': game_state['players'], 'votes': game_state.get('votes', {})})}\n\n"
            break

        game_state["current_round"] = round_number
        round_start_data = {
            'type': 'round_start', 
            'round': round_number, 
            'active_player_ids': active_player_ids,
            'max_rounds': max_rounds
        }
        yield f"data: {json.dumps(round_start_data)}\n\n"
        
        active_players_list_str = ", ".join([p['name'] for p in active_players])
        for player in active_players:
            previous_conversations = "\n".join([f"{msg['name']}: {msg['content']}" for msg in game_state["discussion"]])
            stream = get_ai_description_stream(player["id"], player["word"], round_number, previous_conversations, active_players_list_str)
            for event in stream_ai_response(stream, player["id"], player["name"], round_number):
                yield event

        yield f"data: {json.dumps({'type': 'voting_phase_start', 'round': round_number})}\n\n"
        votes = {}
        all_conversations = "\n".join([f"{msg['name']} (第{msg['round']}轮): {msg['content']}" for msg in game_state["discussion"]])

        for player in active_players:
            other_player_ids = [pid for pid in active_player_ids if pid != player['id']]
            stream = get_ai_vote_stream(player, all_conversations, other_player_ids)
            
            full_response_content = ""
            response_generator = stream_ai_response(stream, player["id"], player["name"], round_number)
            for event_str in response_generator:
                yield event_str
                if event_str.strip():
                    event_data_str = event_str[5:]
                    try:
                        event_data = json.loads(event_data_str)
                        if event_data['type'] == 'message_chunk':
                            full_response_content += event_data.get('content', '')
                    except (json.JSONDecodeError, KeyError):
                        pass

            voted_id = parse_vote_from_text(full_response_content, player['id'], active_player_ids)
            votes[player['id']] = voted_id
            
        game_state["votes"] = votes
        
        vote_values = list(v for v in votes.values() if v is not None)
        if not vote_values:
            yield f"data: {json.dumps({'type': 'tie_vote', 'message': '本轮无人投票，游戏继续。', 'votes': votes})}\n\n"
            round_number += 1
            time.sleep(2)
            continue

        vote_counts = {id: vote_values.count(id) for id in set(vote_values)}
        max_votes = max(vote_counts.values())
        players_with_max_votes = [pid for pid, count in vote_counts.items() if count == max_votes]

        if len(players_with_max_votes) > 1:
            yield f"data: {json.dumps({'type': 'tie_vote', 'message': f'出现平票！玩家 {players_with_max_votes} 均得到了 {max_votes} 票。本轮无人出局，游戏继续。', 'votes': votes})}\n\n"
        else:
            voted_out_id = players_with_max_votes[0]
            voted_out_player = next((p for p in game_state['players'] if p['id'] == voted_out_id), None)
            
            if voted_out_player:
                voted_out_player["active"] = False
                yield f"data: {json.dumps({'type': 'elimination', 'eliminated_player_id': voted_out_id, 'eliminated_player_name': voted_out_player['name'], 'votes': votes})}\n\n"
                time.sleep(1) # Give frontend a moment to process elimination
                
                # BUGFIX 2.0: Check for win condition immediately and end the game if won.
                remaining_undercover_after_vote = [p for p in game_state["players"] if p["active"] and p['isUndercover']]
                if not remaining_undercover_after_vote:
                    game_state["game_over"] = True
                    game_state["winner"] = "平民"
                    game_state["result_message"] = f"所有卧底均已被找出，平民获得胜利！卧底词是“{game_state['undercover_word']}”，平民词是“{game_state['civilian_word']}”。"
                    yield f"data: {json.dumps({'type': 'end', 'winner': game_state['winner'], 'result_message': game_state['result_message'], 'players': game_state['players'], 'votes': game_state.get('votes', {})})}\n\n"
                    break # Terminate the loop as the game is over.


        round_number += 1
        time.sleep(3)

@app.route('/run_game', methods=['POST'])
def run_game_stream():
    settings = request.get_json() if request.data else {}
    total_players = int(settings.get('total_players', 4))
    num_undercover = int(settings.get('num_undercover', 1))
    max_rounds = int(settings.get('max_rounds', 5))

    # Server-side validation
    if total_players < 3: total_players = 3
    if total_players > 10: total_players = 10 # Set a reasonable limit
    if num_undercover < 1: num_undercover = 1
    # Ensure there's at least one more civilian than undercover
    if num_undercover >= total_players / 2:
        num_undercover = (total_players // 2) 
    if num_undercover < 1 : num_undercover = 1


    if max_rounds > 20: max_rounds = 20 # Set a reasonable limit

    return Response(stream_game_events(total_players, num_undercover, max_rounds), mimetype='text/event-stream')

if __name__ == '__main__':
    app.run(debug=True, port=5000, threaded=True)
